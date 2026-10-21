import {gateLegacy} from "./_lib/legacy-access.js";
import { verifyApproval } from "./_lib/approval.js";
import {
  addAuditEvent,
  getBeneficiaryControl,
  getPayment,
  getTelegramWorkspaceMembership,
  roleCan,
  transitionPayment,
  upsertBeneficiary
} from "./_lib/db.js";
import { PAYMENT_STATUS } from "./_lib/state.js";
import { sendTelegramPaymentReceipt } from "./_lib/telegram.js";
import { sendWhatsAppPaymentReceipt } from "./_lib/whatsapp.js";
import { sendWeChatPaymentReceipt } from "./_lib/wechat.js";

const DEVNET = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

async function maybeSendTelegramReceipt(paymentId, approved) {
  if (
    String(approved?.channel || "") !== "telegram-mini-app" ||
    !approved?.telegramUserId
  ) return { attempted: false, sent: false };

  try {
    const fresh = await getPayment(paymentId);
    if (!fresh) return { attempted: true, sent: false };
    const result = await sendTelegramPaymentReceipt({
      payment: fresh,
      userId: approved.telegramUserId,
      base: String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "")
    });
    return {
      attempted: true,
      sent: Boolean(result?.ok),
      idempotent: Boolean(result?.idempotent)
    };
  } catch (error) {
    // A receipt failure must never roll back or misreport a completed settlement.
    await addAuditEvent(paymentId, "telegram_receipt_failed", "settlement-engine", {
      telegram_user_id: String(approved.telegramUserId),
      error: error?.message || "Unknown Telegram receipt error"
    }).catch(() => {});
    return { attempted: true, sent: false, error: error?.message || "Unknown error" };
  }
}

async function maybeSendWhatsAppReceipt(paymentId, approved) {
  if (
    String(approved?.channel || "") !== "whatsapp-web" ||
    !approved?.whatsappUserId
  ) return { attempted: false, sent: false };

  try {
    const fresh = await getPayment(paymentId);
    if (!fresh) return { attempted: true, sent: false };
    const result = await sendWhatsAppPaymentReceipt({
      payment: fresh,
      whatsappUserId: approved.whatsappUserId,
      base: String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "")
    });
    return {
      attempted: true,
      sent: Boolean(result?.ok),
      idempotent: Boolean(result?.idempotent),
      suppressed: Boolean(result?.suppressed)
    };
  } catch (error) {
    await addAuditEvent(paymentId, "whatsapp_receipt_failed", "settlement-engine", {
      whatsapp_user_id: String(approved.whatsappUserId || ""),
      error: error?.message || "Unknown WhatsApp receipt error"
    }).catch(() => {});
    return { attempted: true, sent: false, error: error?.message || "Unknown error" };
  }
}

async function maybeSendWeChatReceipt(paymentId, approved) {
  if (
    String(approved?.channel || "") !== "wechat-web" ||
    !approved?.wechatOpenId
  ) return { attempted: false, sent: false };

  try {
    const fresh = await getPayment(paymentId);
    if (!fresh) return { attempted: true, sent: false };
    const result = await sendWeChatPaymentReceipt({
      payment: fresh,
      wechatOpenId: approved.wechatOpenId,
      base: String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "")
    });
    return {
      attempted: true,
      sent: Boolean(result?.ok),
      idempotent: Boolean(result?.idempotent),
      suppressed: Boolean(result?.suppressed)
    };
  } catch (error) {
    await addAuditEvent(paymentId, "wechat_receipt_failed", "settlement-engine", {
      wechat_open_id: String(approved.wechatOpenId || ""),
      error: error?.message || "Unknown WeChat receipt error"
    }).catch(() => {});
    return { attempted: true, sent: false, error: error?.message || "Unknown error" };
  }
}

async function assertChannelAuthorization(payment, approved) {
  const channel = String(approved?.channel || "");
  if (!["whatsapp-web", "wechat-web"].includes(channel)) return null;

  const isWhatsApp = channel === "whatsapp-web";
  const userId = String(
    isWhatsApp ? approved.whatsappUserId : approved.wechatOpenId
  ).trim();
  const label = isWhatsApp ? "WhatsApp" : "WeChat";
  const identity = isWhatsApp ? `whatsapp:${userId}` : `wechat:${userId}`;
  if (!userId) throw new Error(`${label} approval identity is missing`);

  const membership = await getTelegramWorkspaceMembership(identity);
  if (!membership || !roleCan(membership.member.role, "approve")) {
    throw new Error(`${label} approver no longer has payment approval permission`);
  }
  if (
    !approved.workspaceId ||
    String(membership.workspace.id) !== String(approved.workspaceId) ||
    String(payment.workspace_id || "") !== String(approved.workspaceId)
  ) {
    throw new Error(`${label} payment workspace authorization changed`);
  }

  const control = await getBeneficiaryControl(
    membership.workspace.id,
    payment.supplier,
    payment.destination_currency
  );
  if (control?.status === "blocked") {
    throw new Error(control.note || "Beneficiary is blocked by workspace policy");
  }
  return membership;
}

function sameText(a, b) {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

function assertApprovalMatches(payment, approved) {
  const checks = [
    ["invoiceName", payment.invoice_name, approved.invoiceName],
    ["supplier", payment.supplier, approved.supplier],
    ["sourceCurrency", payment.source_currency, approved.sourceCurrency],
    ["destinationCurrency", payment.destination_currency, approved.destinationCurrency],
    ["destinationAmount", payment.destination_amount, approved.destinationAmount],
    ["route", payment.route, approved.route]
  ];

  for (const [field, stored, signed] of checks) {
    if (!sameText(stored, signed)) {
      throw new Error(`Approval no longer matches stored payment field: ${field}`);
    }
  }

  if (Number(payment.source_amount || 0) !== Number(approved.sourceAmount || 0)) {
    throw new Error("Approval no longer matches stored source amount");
  }
}

async function existingSettlementResponse(payment, connection) {
  if ([PAYMENT_STATUS.SETTLED_DEMO, PAYMENT_STATUS.SETTLED_DEVNET].includes(payment.status) && payment.settlement_signature) {
    const isDevnet = payment.status === PAYMENT_STATUS.SETTLED_DEVNET;
    return {
      mode: isDevnet ? "devnet" : "demo",
      signature: payment.settlement_signature,
      explorer: isDevnet
        ? `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
        : null,
      idempotent: true,
      status: payment.status
    };
  }

  if (
    [PAYMENT_STATUS.SETTLING, PAYMENT_STATUS.FAILED].includes(payment.status) &&
    payment.settlement_signature &&
    !String(payment.settlement_signature).startsWith("demo_")
  ) {
    const status = await connection.getSignatureStatus(payment.settlement_signature, {
      searchTransactionHistory: true
    });

    const confirmed = ["confirmed", "finalized"].includes(status?.value?.confirmationStatus);
    if (confirmed && !status?.value?.err) {
      await transitionPayment(
        payment.id,
        PAYMENT_STATUS.SETTLED_DEVNET,
        {},
        "reconciliation-engine",
        {
          recovered_signature: payment.settlement_signature,
          previous_status: payment.status
        }
      );

      return {
        mode: "devnet",
        signature: payment.settlement_signature,
        explorer: `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`,
        idempotent: true,
        reconciled: true,
        status: PAYMENT_STATUS.SETTLED_DEVNET
      };
    }

    return {
      mode: "devnet",
      signature: payment.settlement_signature,
      explorer: `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`,
      idempotent: true,
      pending: true,
      status: payment.status
    };
  }

  return null;
}

export default async function handler(req, res) {
  if (process.env.NODE_ENV !== "test" && process.env.JACK_ENABLE_LEGACY_SANDBOX !== "true") return res.status(410).json({error:"Legacy sandbox payment workflows are disabled on V2. Use Celo wallet-signed mainnet checkout."});

  if (!["telegram","whatsapp","wechat"].includes(String(req.body?.channel||"").toLowerCase()) && !gateLegacy(req,res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let payment;
  let connection;

  try {
    const { approvalToken, recipient } = req.body || {};
    const approved = verifyApproval(approvalToken);
    const paymentId = approved.paymentId;

    payment = await getPayment(paymentId);
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    await assertChannelAuthorization(payment, approved);

    const hasDevnetConfig = Boolean(
      process.env.SOLANA_DEVNET_PAYER_SECRET_KEY &&
      process.env.SOLANA_SETTLEMENT_RECEIVER
    );

    if (!hasDevnetConfig) {
      if ([PAYMENT_STATUS.SETTLED_DEMO, PAYMENT_STATUS.SETTLED_DEVNET].includes(payment.status) && payment.settlement_signature) {
        const isDevnet = payment.status === PAYMENT_STATUS.SETTLED_DEVNET;
        const telegramReceipt = await maybeSendTelegramReceipt(payment.id, approved);
        const whatsappReceipt = await maybeSendWhatsAppReceipt(payment.id, approved);
        const wechatReceipt = await maybeSendWeChatReceipt(payment.id, approved);
        return res.status(200).json({
          mode: isDevnet ? "devnet" : "demo",
          signature: payment.settlement_signature,
          explorer: isDevnet
            ? `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`
            : null,
          idempotent: true,
          status: payment.status,
          telegramReceipt,
          whatsappReceipt,
          wechatReceipt
        });
      }

      if (payment.status !== PAYMENT_STATUS.APPROVED) {
        return res.status(409).json({
          error: "Payment is not approved",
          detail: `Current status is ${payment.status}`
        });
      }

      assertApprovalMatches(payment, approved);

      const amountUsdg = Number(approved.amountUsdg || 1);
      if (!Number.isFinite(amountUsdg) || amountUsdg <= 0) {
        return res.status(400).json({ error: "Approved USDG amount is invalid" });
      }

      const simulated = "demo_" + Math.random().toString(36).slice(2, 12);

      await transitionPayment(
        payment.id,
        PAYMENT_STATUS.SETTLING,
        { settlement_signature: simulated },
        "settlement-engine",
        { mode: "demo", amount_usdg: amountUsdg }
      );

      await transitionPayment(
        payment.id,
        PAYMENT_STATUS.SETTLED_DEMO,
        {},
        "settlement-engine",
        { mode: "demo", signature: simulated }
      );

      await addAuditEvent(payment.id, "settlement_confirmed", "settlement-engine", {
        mode: "demo",
        signature: simulated
      });

      const telegramReceipt = await maybeSendTelegramReceipt(payment.id, approved);
      const whatsappReceipt = await maybeSendWhatsAppReceipt(payment.id, approved);
      const wechatReceipt = await maybeSendWeChatReceipt(payment.id, approved);

      return res.status(200).json({
        mode: "demo",
        signature: simulated,
        explorer: null,
        idempotent: false,
        telegramReceipt,
        whatsappReceipt,
        wechatReceipt,
        message:
          "Approval was verified and state was reconciled, but Devnet signer/recipient are not configured, so no tokens were moved."
      });
    }

    const [
      { default: bs58 },
      web3,
      splToken
    ] = await Promise.all([
      import("bs58"),
      import("@solana/web3.js"),
      import("@solana/spl-token")
    ]);

    const {
      Connection,
      Keypair,
      PublicKey,
      Transaction
    } = web3;
    const {
      TOKEN_2022_PROGRAM_ID,
      createAssociatedTokenAccountIdempotentInstruction,
      createTransferCheckedInstruction,
      getAssociatedTokenAddress,
      getMint
    } = splToken;

    const raw = JSON.parse(process.env.SOLANA_DEVNET_PAYER_SECRET_KEY);
    const signer = Keypair.fromSecretKey(Uint8Array.from(raw));
    connection = new Connection(DEVNET, "confirmed");

    const existingResponse = await existingSettlementResponse(payment, connection);
    if (existingResponse) {
      const telegramReceipt = existingResponse.pending
        ? { attempted: false, sent: false }
        : await maybeSendTelegramReceipt(payment.id, approved);
      const whatsappReceipt = existingResponse.pending
        ? { attempted: false, sent: false }
        : await maybeSendWhatsAppReceipt(payment.id, approved);
      const wechatReceipt = existingResponse.pending
        ? { attempted: false, sent: false }
        : await maybeSendWeChatReceipt(payment.id, approved);
      return res.status(existingResponse.pending ? 202 : 200).json({
        ...existingResponse,
        telegramReceipt,
        whatsappReceipt,
        wechatReceipt
      });
    }

    if (payment.status !== PAYMENT_STATUS.APPROVED) {
      return res.status(409).json({
        error: "Payment is not approved",
        detail: `Current status is ${payment.status}`
      });
    }

    assertApprovalMatches(payment, approved);

    const amountUsdg = Number(approved.amountUsdg || 1);
    if (!Number.isFinite(amountUsdg) || amountUsdg <= 0) {
      return res.status(400).json({ error: "Approved USDG amount is invalid" });
    }

    const max = Number(process.env.MAX_DEVNET_USDG_PER_PAYMENT || 5);
    if (amountUsdg > max) {
      return res.status(400).json({
        error: `Approved amount exceeds Devnet safety limit of ${max} USDG`
      });
    }

    const mintString =
      process.env.SOLANA_DEVNET_USDG_MINT ||
      "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";
    const fallbackRecipient = process.env.SOLANA_SETTLEMENT_RECEIVER;
    const destination = recipient || fallbackRecipient;

    const mint = new PublicKey(mintString);
    const receiver = new PublicKey(destination);
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    const senderAta = await getAssociatedTokenAddress(mint, signer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const receiverAta = await getAssociatedTokenAddress(mint, receiver, false, TOKEN_2022_PROGRAM_ID);
    const latest = await connection.getLatestBlockhash("confirmed");

    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        receiverAta,
        receiver,
        mint,
        TOKEN_2022_PROGRAM_ID
      ),
      createTransferCheckedInstruction(
        senderAta,
        mint,
        receiverAta,
        signer.publicKey,
        BigInt(Math.round(amountUsdg * (10 ** mintInfo.decimals))),
        mintInfo.decimals,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(signer);

    if (!tx.signature) throw new Error("Transaction signing failed");
    const precomputedSignature = bs58.encode(tx.signature);

    await transitionPayment(
      payment.id,
      PAYMENT_STATUS.SETTLING,
      { settlement_signature: precomputedSignature },
      "settlement-engine",
      {
        mode: "devnet",
        amount_usdg: amountUsdg,
        signature: precomputedSignature,
        mint: mint.toBase58(),
        recipient: receiver.toBase58()
      }
    );

    await addAuditEvent(payment.id, "transaction_signed", "settlement-engine", {
      signature: precomputedSignature,
      blockhash: latest.blockhash,
      last_valid_block_height: latest.lastValidBlockHeight
    });

    const networkSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    if (networkSignature !== precomputedSignature) {
      throw new Error("Network signature did not match the precomputed transaction signature");
    }

    const confirmation = await connection.confirmTransaction(
      {
        signature: networkSignature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight
      },
      "confirmed"
    );

    if (confirmation?.value?.err) {
      throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    const explorer = `https://explorer.solana.com/tx/${networkSignature}?cluster=devnet`;

    await transitionPayment(
      payment.id,
      PAYMENT_STATUS.SETTLED_DEVNET,
      {},
      "settlement-engine",
      {
        mode: "devnet",
        signature: networkSignature,
        mint: mint.toBase58(),
        recipient: receiver.toBase58()
      }
    );

    await upsertBeneficiary({
      supplier: payment.supplier,
      destinationCurrency: payment.destination_currency,
      beneficiary: payment.beneficiary || {},
      metadata: {
        payment_id: payment.id,
        verified_by: "successful_devnet_settlement"
      }
    });

    await addAuditEvent(payment.id, "settlement_confirmed", "settlement-engine", {
      mode: "devnet",
      signature: networkSignature,
      explorer
    });

    const telegramReceipt = await maybeSendTelegramReceipt(payment.id, approved);
    const whatsappReceipt = await maybeSendWhatsAppReceipt(payment.id, approved);
    const wechatReceipt = await maybeSendWeChatReceipt(payment.id, approved);

    return res.status(200).json({
      mode: "devnet",
      signature: networkSignature,
      explorer,
      idempotent: false,
      telegramReceipt,
      whatsappReceipt,
      wechatReceipt
    });
  } catch (error) {
    console.error("settlement failed", error);

    if (payment?.id) {
      try {
        const current = await getPayment(payment.id);
        if (current?.status === PAYMENT_STATUS.SETTLING) {
          await transitionPayment(
            payment.id,
            PAYMENT_STATUS.FAILED,
            {},
            "settlement-engine",
            {
              error: error?.message || "Unknown error",
              signature: current.settlement_signature || null
            }
          );
        }
      } catch {
        // Preserve the original settlement error.
      }
    }

    return res.status(400).json({
      error: "Settlement rejected",
      detail: error?.message || "Unknown error"
    });
  }
}

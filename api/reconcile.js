import {gateLegacy} from "./_lib/legacy-access.js";
import crypto from "node:crypto";
import { Connection } from "@solana/web3.js";
import {
  addAuditEvent,
  getPayment,
  transitionPayment
} from "./_lib/db.js";
import {
  findPayoutByProviderTransferId,
  savePayout
} from "./_lib/payout-store.js";
import { mapWiseProviderStatus } from "./_lib/payout-provider.js";
import { PAYMENT_STATUS } from "./_lib/state.js";

export const config = { api: { bodyParser: false } };

const DEVNET = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

const WISE_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`;

const WISE_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`;

async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseJsonBuffer(raw) {
  if (!raw?.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function verifyWiseSignature(rawBody, signature) {
  if (!signature) return false;
  const explicitKey = String(process.env.WISE_WEBHOOK_PUBLIC_KEY || "").replace(/\\n/g, "\n").trim();
  const sandbox =
    String(process.env.WISE_WEBHOOK_ENV || "").toLowerCase() === "sandbox" ||
    String(process.env.PAYOUT_PROVIDER || "").toLowerCase() === "wise_sandbox";
  const publicKey = explicitKey || (sandbox ? WISE_SANDBOX_PUBLIC_KEY : WISE_PRODUCTION_PUBLIC_KEY);
  return crypto.verify(
    "RSA-SHA256",
    rawBody,
    publicKey,
    Buffer.from(String(signature), "base64")
  );
}

function isOlderEvent(stored, incoming) {
  const oldTs = Date.parse(stored || "");
  const newTs = Date.parse(incoming || "");
  return Number.isFinite(oldTs) && Number.isFinite(newTs) && newTs < oldTs;
}

async function handleWiseWebhook(req, res, rawBody) {
  const signature =
    req.headers?.["x-signature-sha256"] ||
    req.headers?.["X-Signature-SHA256"];

  if (!verifyWiseSignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid Wise webhook signature" });
  }

  let event;
  try {
    event = parseJsonBuffer(rawBody);
  } catch {
    return res.status(400).json({ error: "Invalid webhook JSON" });
  }

  const eventType = String(event?.event_type || "");
  const data = event?.data || {};
  const transferId =
    data?.resource?.id ||
    data?.transfer_id ||
    null;
  const occurredAt =
    data?.occurred_at ||
    data?.resource?.occurred_at ||
    event?.sent_at ||
    null;

  if (!transferId) {
    return res.status(200).json({
      accepted: true,
      matched: false,
      eventType,
      test: String(req.headers?.["x-test-notification"] || "").toLowerCase() === "true"
    });
  }

  const payout = await findPayoutByProviderTransferId(transferId);
  if (!payout) {
    return res.status(200).json({
      accepted: true,
      matched: false,
      eventType,
      transferId: String(transferId)
    });
  }

  if (isOlderEvent(payout.quote?.providerOccurredAt, occurredAt)) {
    return res.status(200).json({
      accepted: true,
      matched: true,
      ignored: "out_of_order",
      payoutId: payout.id
    });
  }

  let nextStatus = payout.status;
  let providerStatus = payout.quote?.providerStatus || null;
  let providerStatusLabel = payout.quote?.providerStatusLabel || null;
  const quotePatch = {
    ...payout.quote,
    providerOccurredAt: occurredAt,
    providerDeliveryId: req.headers?.["x-delivery-id"] || null,
    providerLastEventType: eventType
  };

  if (eventType === "transfers#state-change") {
    const mapped = mapWiseProviderStatus(data?.current_state);
    nextStatus = mapped.localStatus;
    providerStatus = mapped.providerStatus;
    providerStatusLabel = mapped.friendlyStatus;
    Object.assign(quotePatch, {
      providerStatus,
      providerStatusLabel,
      providerPreviousStatus: data?.previous_state || null
    });
  } else if (eventType === "transfers#payout-failure") {
    nextStatus = "attention_external";
    Object.assign(quotePatch, {
      providerFailureCode: data?.failure_reason_code || null,
      providerFailureDescription: data?.failure_description || null
    });
  } else if (eventType === "transfers#refund") {
    nextStatus = "refunded_external";
    Object.assign(quotePatch, {
      refundAmount: data?.resource?.refund_amount ?? null,
      refundCurrency: data?.resource?.refund_currency || null
    });
  } else {
    return res.status(200).json({
      accepted: true,
      matched: true,
      ignored: "unsupported_event",
      payoutId: payout.id,
      eventType
    });
  }

  const updated = await savePayout({
    ...payout,
    quote: quotePatch,
    status: nextStatus
  });

  await addAuditEvent(payout.id, "fiat_payout_provider_webhook", "wise-webhook", {
    delivery_id: req.headers?.["x-delivery-id"] || null,
    event_type: eventType,
    occurred_at: occurredAt,
    transfer_id: String(transferId),
    previous_status: payout.status,
    local_status: nextStatus,
    provider_status: providerStatus,
    provider_status_label: providerStatusLabel,
    failure_code: data?.failure_reason_code || null
  });

  if (nextStatus === "reconciled_external" && payout.status !== "reconciled_external") {
    await addAuditEvent(payout.id, "fiat_payout_reconciled", "reconciliation-engine", {
      mode: "wise_webhook",
      receipt_id: updated.receipt_id,
      transfer_id: String(transferId),
      provider_status: providerStatus,
      destination_currency: updated.destination_currency,
      destination_amount: Number(updated.destination_amount)
    });
  }

  return res.status(200).json({
    accepted: true,
    matched: true,
    payoutId: payout.id,
    status: nextStatus,
    providerStatus
  });
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "GET or POST only" });
  }

  let body = {};
  let rawBody = Buffer.alloc(0);

  if (req.method === "POST") {
    rawBody = await readRawBody(req);
    const provider = String(req.query?.provider || "").toLowerCase();
    if (provider === "wise") {
      return handleWiseWebhook(req, res, rawBody);
    }
    try {
      body = parseJsonBuffer(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  if (!gateLegacy(req,res)) return;
  const paymentId = req.query?.id || body?.paymentId;
  if (!paymentId) return res.status(400).json({ error: "payment id is required" });

  const payment = await getPayment(paymentId);
  if (!payment) return res.status(404).json({ error: "Payment not found" });

  if ([PAYMENT_STATUS.SETTLED_DEMO, PAYMENT_STATUS.SETTLED_DEVNET].includes(payment.status)) {
    return res.status(200).json({
      status: payment.status,
      signature: payment.settlement_signature,
      reconciled: true
    });
  }

  if (!payment.settlement_signature) {
    return res.status(200).json({
      status: payment.status,
      reconciled: false,
      pending: false,
      message: "No settlement signature is recorded yet."
    });
  }

  if (String(payment.settlement_signature).startsWith("demo_")) {
    if ([PAYMENT_STATUS.SETTLING, PAYMENT_STATUS.FAILED].includes(payment.status)) {
      await transitionPayment(
        payment.id,
        PAYMENT_STATUS.SETTLED_DEMO,
        {},
        "reconciliation-engine",
        { signature: payment.settlement_signature }
      );
    }
    return res.status(200).json({
      status: PAYMENT_STATUS.SETTLED_DEMO,
      signature: payment.settlement_signature,
      reconciled: true,
      mode: "demo"
    });
  }

  const connection = new Connection(DEVNET, "confirmed");
  const result = await connection.getSignatureStatus(payment.settlement_signature, {
    searchTransactionHistory: true
  });

  const chainStatus = result?.value || null;
  const confirmed =
    chainStatus &&
    !chainStatus.err &&
    ["confirmed", "finalized"].includes(chainStatus.confirmationStatus);

  if (confirmed && [PAYMENT_STATUS.SETTLING, PAYMENT_STATUS.FAILED].includes(payment.status)) {
    await transitionPayment(
      payment.id,
      PAYMENT_STATUS.SETTLED_DEVNET,
      {},
      "reconciliation-engine",
      {
        recovered_signature: payment.settlement_signature,
        confirmation_status: chainStatus.confirmationStatus
      }
    );

    await addAuditEvent(payment.id, "settlement_reconciled", "reconciliation-engine", {
      signature: payment.settlement_signature,
      confirmation_status: chainStatus.confirmationStatus
    });
  }

  return res.status(200).json({
    status: confirmed ? PAYMENT_STATUS.SETTLED_DEVNET : payment.status,
    signature: payment.settlement_signature,
    explorer: `https://explorer.solana.com/tx/${payment.settlement_signature}?cluster=devnet`,
    reconciled: Boolean(confirmed),
    pending: !confirmed && !chainStatus?.err,
    chain: chainStatus
      ? {
          confirmationStatus: chainStatus.confirmationStatus,
          confirmations: chainStatus.confirmations,
          err: chainStatus.err
        }
      : null
  });
}

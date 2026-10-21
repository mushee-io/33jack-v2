import {gateLegacy} from "./_lib/legacy-access.js";
import { addAuditEvent, getBeneficiaryControl, getTelegramWorkspaceMembership, roleCan } from "./_lib/db.js";
import { verifyPayoutApproval } from "./_lib/payout-approval.js";
import { getPayout, savePayout } from "./_lib/payout-store.js";
import { executeExternalPayout, getExternalPayoutStatus } from "./_lib/payout-provider.js";

function sameValue(a, b) {
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return String(a ?? "") === String(b ?? "");
}

function sameBeneficiary(stored = {}, approved = {}) {
  const keys = ["name", "bank_name", "account_last4", "country"];
  return keys.every((key) =>
    String(stored?.[key] ?? "").trim() === String(approved?.[key] ?? "").trim()
  );
}

function externalReceipt(payout, tracking = null) {
  const beneficiary = payout?.beneficiary || {};
  const providerStatus =
    tracking?.providerStatus ||
    payout?.quote?.providerStatus ||
    "unknown";
  const reconciled =
    tracking?.reconciled === true ||
    payout?.status === "reconciled_external";

  return {
    id:
      payout?.receipt_id ||
      (payout?.quote?.providerTransferId
        ? `WISE-${payout.quote.providerTransferId}`
        : null),
    status: reconciled
      ? "PAID (WISE SANDBOX)"
      : tracking?.friendlyStatus
        ? tracking.friendlyStatus.toUpperCase()
        : "TRACKING (WISE SANDBOX)",
    funding: `${payout?.funding_amount} ${payout?.funding_asset}`,
    delivered: `${payout?.destination_amount} ${payout?.destination_currency}`,
    beneficiary: beneficiary?.name || "Beneficiary",
    bank: beneficiary?.bank_name || "Bank",
    account_last4: beneficiary?.account_last4 || null,
    reconciled,
    provider: payout?.quote?.partner || "Wise Sandbox",
    provider_status: providerStatus,
    provider_transfer_id: payout?.quote?.providerTransferId || null
  };
}

export default async function handler(req, res) {
  if (process.env.NODE_ENV !== "test" && process.env.JACK_ENABLE_LEGACY_SANDBOX !== "true") return res.status(410).json({error:"Legacy sandbox payment workflows are disabled on V2. Use Celo wallet-signed mainnet checkout."});

  if (String(req.body?.channel||"").toLowerCase()!=="telegram" && !gateLegacy(req,res)) return;
  try {
    if (req.method === "GET") {
      const payout = await getPayout(req.query?.payoutId);
      if (!payout) return res.status(404).json({ error: "Payout not found" });

      const provider = String(payout.quote?.provider || "internal_sandbox");
      if (provider === "internal_sandbox") {
        return res.status(200).json({
          payout,
          receipt: payout.receipt_id
            ? {
                id: payout.receipt_id,
                status: payout.status === "paid_sandbox" ? "PAID (SANDBOX)" : payout.status,
                funding: `${payout.funding_amount} ${payout.funding_asset}`,
                delivered: `${payout.destination_amount} ${payout.destination_currency}`,
                beneficiary: payout.beneficiary?.name || "Beneficiary",
                bank: payout.beneficiary?.bank_name || "Bank",
                account_last4: payout.beneficiary?.account_last4 || null,
                reconciled: payout.status === "paid_sandbox"
              }
            : null
        });
      }

      const tracking = await getExternalPayoutStatus(payout);
      const previousProviderStatus = payout.quote?.providerStatus || null;
      const providerQuote = {
        ...payout.quote,
        providerStatus: tracking.providerStatus,
        providerStatusLabel: tracking.friendlyStatus,
        providerStatusCheckedAt: new Date().toISOString()
      };

      const updated = await savePayout({
        ...payout,
        quote: providerQuote,
        status: tracking.localStatus
      });

      if (previousProviderStatus !== tracking.providerStatus) {
        await addAuditEvent(payout.id, "fiat_payout_provider_status", "wise-status-tracker", {
          provider: "wise_sandbox",
          transfer_id: tracking.transferId,
          previous_status: previousProviderStatus,
          provider_status: tracking.providerStatus,
          local_status: tracking.localStatus
        });
      }

      if (
        tracking.reconciled &&
        payout.status !== "reconciled_external"
      ) {
        await addAuditEvent(payout.id, "fiat_payout_reconciled", "reconciliation-engine", {
          mode: "wise_sandbox",
          receipt_id: updated.receipt_id,
          transfer_id: tracking.transferId,
          provider_status: tracking.providerStatus,
          destination_currency: updated.destination_currency,
          destination_amount: Number(updated.destination_amount)
        });
      }

      return res.status(200).json({
        payout: updated,
        tracking,
        receipt: externalReceipt(updated, tracking)
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "GET or POST only" });
    }
    const approved = verifyPayoutApproval(req.body?.approvalToken);
    const payout = await getPayout(approved.payoutId);
    if (!payout) return res.status(404).json({ error: "Payout not found" });

    if (String(approved.channel || "") === "telegram-mini-app") {
      const membership = await getTelegramWorkspaceMembership(approved.telegramUserId);
      if (!membership || !roleCan(membership.member.role, "approve")) {
        return res.status(403).json({ error: "Telegram approver no longer has payout approval permission" });
      }
      if (
        !approved.workspaceId ||
        String(membership.workspace.id) !== String(approved.workspaceId) ||
        String(payout.workspace_id || "") !== String(approved.workspaceId)
      ) {
        return res.status(403).json({ error: "Payout workspace authorization changed" });
      }
      const control = await getBeneficiaryControl(
        membership.workspace.id,
        payout.beneficiary?.name,
        payout.destination_currency
      );
      if (control?.status === "blocked") {
        return res.status(403).json({
          error: "Beneficiary was blocked after approval",
          detail: control.note || payout.beneficiary?.name || "Blocked beneficiary"
        });
      }
    }

    const provider = String(payout.quote?.provider || "internal_sandbox");

    if (payout.status === "paid_sandbox" && payout.receipt_id) {
      return res.status(200).json({ payout, idempotent: true });
    }

    if (
      provider !== "internal_sandbox" &&
      ["external_created", "processing_external"].includes(payout.status) &&
      payout.receipt_id
    ) {
      const receiptBeneficiary = approved.beneficiary || payout.beneficiary || {};
      return res.status(200).json({
        payout,
        idempotent: true,
        receipt: {
          id: payout.receipt_id,
          status:
            payout.status === "processing_external"
              ? "SUBMITTED (WISE SANDBOX)"
              : "CREATED (WISE SANDBOX)",
          funding: `${payout.funding_amount} ${payout.funding_asset}`,
          delivered: `${payout.destination_amount} ${payout.destination_currency}`,
          beneficiary: receiptBeneficiary.name || "Beneficiary",
          bank: receiptBeneficiary.bank_name || "Bank",
          account_last4: receiptBeneficiary.account_last4 || null,
          reconciled: false,
          provider: payout.quote?.partner || provider,
          provider_status: payout.quote?.providerStatus || null
        }
      });
    }

    const retryingExternalSubmission =
      provider !== "internal_sandbox" &&
      payout.status === "processing_external" &&
      !payout.receipt_id;

    if (payout.status !== "approved" && !retryingExternalSubmission) {
      return res.status(409).json({ error: "Payout is not approved", detail: payout.status });
    }

    const termsMatch =
      sameValue(payout.funding_asset, approved.fundingAsset) &&
      sameValue(Number(payout.funding_amount), Number(approved.fundingAmount)) &&
      sameValue(payout.destination_currency, approved.destinationCurrency) &&
      sameValue(Number(payout.destination_amount), Number(approved.destinationAmount)) &&
      sameValue(Number(payout.exchange_rate), Number(approved.exchangeRate)) &&
      sameValue(Number(payout.fee_amount), Number(approved.feeAmount)) &&
      sameValue(provider, approved.provider || "internal_sandbox") &&
      sameValue(
        payout.quote?.providerQuoteId || "",
        approved.providerQuoteId || ""
      ) &&
      sameBeneficiary(payout.beneficiary, approved.beneficiary) &&
      sameValue(payout.workspace_id || "", approved.workspaceId || payout.workspace_id || "");

    if (!termsMatch) {
      throw new Error("Approved payout terms changed before settlement");
    }

    if (provider !== "internal_sandbox") {
      await savePayout({ ...payout, status: "processing_external" });
      await addAuditEvent(payout.id, "fiat_payout_provider_submitted", "payout-provider-adapter", {
        provider,
        provider_quote_id: payout.quote?.providerQuoteId || null
      });

      const providerResult = await executeExternalPayout(payout);
      if (!providerResult) throw new Error("Configured payout provider is not supported");

      const receiptBeneficiary = approved.beneficiary || payout.beneficiary || {};
      const receiptId = providerResult.transferId
        ? `WISE-${providerResult.transferId}`
        : "33J-EXT-" + Date.now().toString(36).toUpperCase();
      const nextStatus = providerResult.funded ? "processing_external" : "external_created";

      const providerQuote = {
        ...payout.quote,
        providerTransferId: providerResult.transferId || null,
        providerStatus: providerResult.providerStatus || null,
        fundingStatus: providerResult.fundingStatus || null,
        balanceTransactionId: providerResult.balanceTransactionId || null,
        customerTransactionId: providerResult.customerTransactionId || null
      };

      const submitted = await savePayout({
        ...payout,
        quote: providerQuote,
        status: nextStatus,
        receipt_id: receiptId
      });

      await addAuditEvent(payout.id, "fiat_payout_provider_created", "payout-provider-adapter", {
        provider,
        transfer_id: providerResult.transferId || null,
        provider_status: providerResult.providerStatus || null,
        funding_status: providerResult.fundingStatus || null
      });

      return res.status(200).json({
        payout: submitted,
        idempotent: false,
        provider: providerResult,
        receipt: {
          id: receiptId,
          status: providerResult.funded
            ? "SUBMITTED (WISE SANDBOX)"
            : "CREATED (WISE SANDBOX)",
          funding: `${payout.funding_amount} ${payout.funding_asset}`,
          delivered: `${payout.destination_amount} ${payout.destination_currency}`,
          beneficiary: receiptBeneficiary.name || "Beneficiary",
          bank: receiptBeneficiary.bank_name || "Bank",
          account_last4: receiptBeneficiary.account_last4 || null,
          reconciled: false,
          provider: payout.quote?.partner || "Wise Sandbox",
          provider_status: providerResult.providerStatus || null
        }
      });
    }

    await savePayout({ ...payout, status: "processing" });
    await addAuditEvent(payout.id, "fiat_payout_processing", "sandbox-payout-adapter", {
      partner: payout.quote?.partner || "33Jack Sandbox Payout Rail"
    });

    const receiptId = "33J-FIAT-" + Date.now().toString(36).toUpperCase();
    const settled = await savePayout({
      ...payout,
      status: "paid_sandbox",
      receipt_id: receiptId
    });

    const receiptBeneficiary = approved.beneficiary || payout.beneficiary || {};

    await addAuditEvent(payout.id, "fiat_payout_reconciled", "reconciliation-engine", {
      mode: "sandbox",
      receipt_id: receiptId,
      destination_currency: payout.destination_currency,
      destination_amount: Number(payout.destination_amount),
      beneficiary: {
        name: receiptBeneficiary.name || null,
        bank_name: receiptBeneficiary.bank_name || null,
        account_last4: receiptBeneficiary.account_last4 || null,
        country: receiptBeneficiary.country || null
      }
    });

    return res.status(200).json({
      payout: settled,
      idempotent: false,
      receipt: {
        id: receiptId,
        status: "PAID (SANDBOX)",
        funding: `${payout.funding_amount} ${payout.funding_asset}`,
        delivered: `${payout.destination_amount} ${payout.destination_currency}`,
        beneficiary: receiptBeneficiary.name || "Beneficiary",
        bank: receiptBeneficiary.bank_name || "Bank",
        account_last4: receiptBeneficiary.account_last4 || null,
        reconciled: true
      }
    });
  } catch (error) {
    return res.status(400).json({
      error: "Sandbox payout failed",
      detail: error?.message || "Unknown error"
    });
  }
}

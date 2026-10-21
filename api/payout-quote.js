import {gateLegacy} from "./_lib/legacy-access.js";
import { addAuditEvent, getBeneficiaryControl, getOrCreateTelegramWorkspace, getPayment, roleCan } from "./_lib/db.js";
import { verifyTelegramInitData } from "./_lib/telegram-auth.js";
import { getPayoutQuote } from "./_lib/payout-provider.js";
import { getPayout, savePayout } from "./_lib/payout-store.js";

function cleanBeneficiary(input = {}) {
  return {
    name: String(input.name || "").trim(),
    bank_name: String(input.bank_name || "").trim(),
    account_last4: String(input.account_last4 || "").trim().slice(-4),
    country: String(input.country || "").trim()
  };
}

export default async function handler(req, res) {
  if (String(req.body?.channel||"").toLowerCase()!=="telegram" && !gateLegacy(req,res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body || {};
    let telegramAuth = null;
    let workspaceContext = null;
    if (String(body.channel || "").toLowerCase() === "telegram") {
      telegramAuth = verifyTelegramInitData(body.telegramInitData, 3600);
      workspaceContext = await getOrCreateTelegramWorkspace(telegramAuth.user);
      if (!roleCan(workspaceContext.member.role, "operate")) {
        return res.status(403).json({ error: "Your workspace role cannot create payout quotes" });
      }
    }

    const beneficiary = cleanBeneficiary(body.beneficiary);
    const missing = Object.entries(beneficiary).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) {
      return res.status(400).json({ error: "Beneficiary details are incomplete", detail: missing.join(", ") });
    }

    if (workspaceContext) {
      const control = await getBeneficiaryControl(
        workspaceContext.workspace.id,
        beneficiary.name,
        body.destinationCurrency
      );
      if (control?.status === "blocked") {
        return res.status(403).json({
          error: "Beneficiary is blocked by workspace policy",
          detail: control.note || beneficiary.name
        });
      }

      if (body.sourcePaymentId) {
        const sourcePayment = await getPayment(body.sourcePaymentId);
        if (!sourcePayment || String(sourcePayment.workspace_id || "") !== String(workspaceContext.workspace.id)) {
          return res.status(403).json({ error: "Source invoice is not available to this workspace" });
        }
      }
    }

    const quote = await getPayoutQuote({ ...body, payoutId: body.payoutId });
    const requestedId = String(body.payoutId || "").trim();
    const existing = requestedId ? await getPayout(requestedId) : null;
    const payoutId =
      existing && existing.status === "quoted"
        ? existing.id
        : "payout_" + Date.now().toString(36);

    const payout = await savePayout({
      id: payoutId,
      invoice_ref: String(body.invoiceRef || "").trim() || null,
      funding_asset: quote.fundingAsset,
      funding_amount: quote.fundingAmount,
      destination_currency: quote.destinationCurrency,
      destination_amount: quote.destinationAmount,
      exchange_rate: quote.exchangeRate,
      fee_amount: quote.feeAmount,
      quote,
      beneficiary,
      status: "quoted",
      workspace_id: workspaceContext?.workspace?.id || existing?.workspace_id || null
    });

    await addAuditEvent(
      payout.id,
      "fiat_payout_quoted",
      telegramAuth ? `telegram-user:${telegramAuth.user.id}` : "33jack-pay",
      {
      mode: quote.mode || "sandbox",
      provider: quote.provider || "internal_sandbox",
      funding_asset: quote.fundingAsset,
      funding_amount: quote.fundingAmount,
      destination_currency: quote.destinationCurrency,
      destination_amount: quote.destinationAmount,
      fee_amount: quote.feeAmount,
      workspace_id: payout.workspace_id || null,
      source_payment_id: body.sourcePaymentId || null
    });

    return res.status(200).json({ payout });
  } catch (error) {
    return res.status(400).json({
      error: "Could not prepare payout quote",
      detail: error?.message || "Unknown error"
    });
  }
}

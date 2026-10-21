import {gateLegacy} from "./_lib/legacy-access.js";
import { addAuditEvent, getBeneficiaryControl, getOrCreateTelegramWorkspace, roleCan } from "./_lib/db.js";
import { verifyTelegramInitData } from "./_lib/telegram-auth.js";
import { signPayoutApproval } from "./_lib/payout-approval.js";
import { getPayoutQuote } from "./_lib/payout-provider.js";
import { getPayout, savePayout } from "./_lib/payout-store.js";
import { evaluatePayoutPolicy } from "./_lib/policy.js";

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
      if (!roleCan(workspaceContext.member.role, "approve")) {
        return res.status(403).json({ error: "Your workspace role cannot approve payouts" });
      }
    }

    let payout = await getPayout(body.payoutId);
    if (!payout) return res.status(404).json({ error: "Payout not found" });

    if (workspaceContext) {
      if (!payout.workspace_id || String(payout.workspace_id) !== String(workspaceContext.workspace.id)) {
        return res.status(403).json({ error: "Payout is not available to this workspace" });
      }
      const control = await getBeneficiaryControl(
        workspaceContext.workspace.id,
        payout.beneficiary?.name,
        payout.destination_currency
      );
      if (control?.status === "blocked") {
        return res.status(403).json({
          error: "Beneficiary is blocked by workspace policy",
          detail: control.note || payout.beneficiary?.name || "Blocked beneficiary"
        });
      }
    }

    if (payout.status === "approved") {
      return res.status(200).json({
        payout,
        approvalToken: signPayoutApproval(payout, {
          workspaceId: workspaceContext?.workspace?.id || payout.workspace_id || null,
          channel: telegramAuth ? "telegram-mini-app" : "web",
          telegramUserId: telegramAuth?.user?.id || null,
          approverRole: workspaceContext?.member?.role || null
        }),
        mode: process.env.APPROVAL_HMAC_SECRET ? "secure" : "demo",
        idempotent: true
      });
    }

    if (payout.status !== "quoted") {
      return res.status(409).json({ error: "Payout is not awaiting approval", detail: payout.status });
    }
    if (Date.now() > Number(payout.quote?.expiresAt || 0)) {
      const previousTerms = {
        destinationAmount: Number(payout.destination_amount),
        exchangeRate: Number(payout.exchange_rate),
        feeAmount: Number(payout.fee_amount)
      };

      const freshQuote = await getPayoutQuote({
        payoutId: payout.id,
        invoiceRef: payout.invoice_ref,
        fundingAsset: payout.funding_asset,
        fundingAmount: Number(payout.funding_amount),
        destinationCurrency: payout.destination_currency
      });

      const refreshed = await savePayout({
        ...payout,
        destination_amount: freshQuote.destinationAmount,
        exchange_rate: freshQuote.exchangeRate,
        fee_amount: freshQuote.feeAmount,
        quote: freshQuote,
        status: "quoted"
      });

      await addAuditEvent(payout.id, "fiat_payout_quote_refreshed", "33jack-pay", {
        previous_expires_at: payout.quote?.expiresAt || null,
        refreshed_expires_at: freshQuote.expiresAt,
        destination_amount: freshQuote.destinationAmount,
        exchange_rate: freshQuote.exchangeRate,
        fee_amount: freshQuote.feeAmount
      });

      const termsChanged =
        previousTerms.destinationAmount !== Number(freshQuote.destinationAmount) ||
        previousTerms.exchangeRate !== Number(freshQuote.exchangeRate) ||
        previousTerms.feeAmount !== Number(freshQuote.feeAmount);

      if (termsChanged) {
        return res.status(409).json({
          error: "Quote changed",
          detail: "The FX or fee terms changed. Review the refreshed quote before approving.",
          refreshedPayout: refreshed
        });
      }

      // Sandbox rates are deterministic. If the refreshed economics are identical,
      // continue approval in the same request instead of forcing a pointless second click.
      payout = refreshed;
    }

    const policy = evaluatePayoutPolicy(payout);
    await addAuditEvent(payout.id, "fiat_payout_policy_checked", "policy-engine", {
      allowed: policy.allowed,
      reasons: policy.reasons,
      config: policy.config
    });
    if (!policy.allowed) {
      return res.status(403).json({
        error: "Payout blocked by policy",
        detail: policy.reasons.join("; "),
        policy
      });
    }

    const approvalToken = signPayoutApproval(payout, {
      workspaceId: workspaceContext?.workspace?.id || payout.workspace_id || null,
      channel: telegramAuth ? "telegram-mini-app" : "web",
      telegramUserId: telegramAuth?.user?.id || null,
      approverRole: workspaceContext?.member?.role || null
    });
    const updated = await savePayout({ ...payout, status: "approved" });

    await addAuditEvent(
      payout.id,
      "fiat_payout_approved",
      telegramAuth ? `telegram-user:${telegramAuth.user.id}` : "human-approver",
      {
      funding_asset: payout.funding_asset,
      funding_amount: Number(payout.funding_amount),
      destination_currency: payout.destination_currency,
      destination_amount: Number(payout.destination_amount),
      fee_amount: Number(payout.fee_amount),
      workspace_id: payout.workspace_id || null,
      approver_role: workspaceContext?.member?.role || null
    });

    return res.status(200).json({
      payout: updated,
      approvalToken,
      mode: process.env.APPROVAL_HMAC_SECRET ? "secure" : "demo"
    });
  } catch (error) {
    return res.status(400).json({
      error: "Payout approval failed",
      detail: error?.message || "Unknown error"
    });
  }
}

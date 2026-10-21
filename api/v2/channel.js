import { randomUUID } from "node:crypto";
import { requireHumanApproval } from "../_lib/agent-v2-auth.js";
import { authorizeChannelInvoice, assertInvoiceEligibility, safeInvoiceSummary } from "../_lib/channel-v2-auth.js";
import { normalizeCeloProposal, prepareCeloTransfer, verifyCeloPayment } from "../_lib/celo-v2.js";
import { addAuditEvent, markCeloInvoiceSettled } from "../_lib/db.js";
import { proposeV2Intent, getV2Intent, getV2IntentForInvoice, approveV2Intent, recordV2Confirmation } from "../_lib/agent-v2-store.js";

const errorJson = (res, err) => res.status(err?.status || (err?.code === "23505" ? 409 : 400)).json({
  ok: false,
  error: err?.status === 503 ? "V2 integration is not configured" : String(err?.message || "Celo checkout failed").slice(0, 260)
});
function strictUuid(id) {
  const s = String(id || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw Object.assign(new Error("Invalid proposal ID"),{status:400});
  return s;
}
function enforceBoundInvoice(intent, paymentId) {
  if (!intent || intent.memo !== "33JACK invoice:" + paymentId) throw Object.assign(new Error("This proposal does not belong to the requested invoice"),{status:404});
  return intent;
}
async function lookupInvoiceIntent(context) {
  const intent = await getV2IntentForInvoice(context.actorId, "invoice:" + context.payment.id);
  return intent && enforceBoundInvoice(intent, context.payment.id);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const op = String(req.query?.operation || "").toLowerCase();
  if (!["context", "propose", "approve", "confirm", "refresh"].includes(op)) return res.status(404).json({ error: "Unknown channel action" });
  if (Number(req.headers["content-length"] || 0) > 12000) return res.status(413).json({ error: "Request too large" });
  try {
    const body = req.body || {};
    const capability = op === "propose" ? "operate" : op === "approve" ? "approve" : "view";
    const ctx = await authorizeChannelInvoice(body, capability);
    const summary = safeInvoiceSummary(ctx.payment, ctx.role);
    if (op === "context") {
      const existing = await lookupInvoiceIntent(ctx);
      return res.status(200).json({ ok: true, channel: ctx.channel, invoice: summary, intent: existing });
    }
    if (op === "propose") {
      const risk = assertInvoiceEligibility(ctx.payment, body.acknowledgements || {});
      if (body.confirmExactTerms !== true) throw Object.assign(new Error("Verify the exact wallet address and amount before proposing"),{status:400});
      const input = normalizeCeloProposal({
        token: body.token, amount: body.amount, recipient: body.recipient,
        payer: body.payer, memo: "33JACK invoice:" + ctx.payment.id
      });
      if (!input.payer) throw Object.assign(new Error("Connected payer wallet is required"),{status:400});
      const origin = { channel: ctx.channel, workspaceId: ctx.workspaceId, invoiceId: ctx.payment.id,
        invoiceRef: summary.invoice, createdBy: ctx.identity, riskAcknowledged: risk.acknowledgements };
      const result = await proposeV2Intent(ctx.actorId, { ...input, sourceContext: origin }, "invoice:" + ctx.payment.id);
      await addAuditEvent(ctx.payment.id,"celo_v2_proposed",ctx.identity, {
        intent_id:result.intent.id, channel:ctx.channel, workspace_id:ctx.workspaceId, risk_flags:risk.flags, created:result.created
      });
      return res.status(result.created ? 201 : 200).json({ ok:true, ...result, invoice:summary });
    }
    const id = strictUuid(body.id);
    const intent = enforceBoundInvoice(await getV2Intent(ctx.actorId,id),ctx.payment.id);
    if (op === "refresh") {
      return res.status(200).json({ ok:true, invoice:summary, intent,
        unsignedTransaction: intent.status==="approved" ? prepareCeloTransfer(intent) : null });
    }
    if (op === "approve") {
      const gate = requireHumanApproval(req);
      if (gate.error) return res.status(gate.status).json({error:gate.error});
      // The invoice can become invalid between proposal and approval.
      assertInvoiceEligibility(ctx.payment,intent.sourceContext?.riskAcknowledged || {});
      if (intent.status !== "proposed") throw Object.assign(new Error("Payment cannot be approved from current state"),{status:409});
      if (body.confirmation !== "APPROVE:" + id) throw Object.assign(new Error("Exact approval confirmation required"),{status:400});
      if (body.confirmTerms?.recipient?.toLowerCase() !== intent.recipient ||
          body.confirmTerms?.payer?.toLowerCase() !== intent.payer ||
          String(body.confirmTerms?.amount) !== intent.amount ||
          String(body.confirmTerms?.token) !== intent.token) {
        throw Object.assign(new Error("Approval details differ from the original proposal"),{status:409});
      }
      const updated = await approveV2Intent(ctx.actorId,id);
      if (!updated) throw Object.assign(new Error("Proposal expired or has already changed state"),{status:409});
      await addAuditEvent(ctx.payment.id,"celo_v2_approved",ctx.identity,{
        intent_id:id,channel:ctx.channel,workspace_id:ctx.workspaceId
      });
      return res.status(200).json({ ok:true,intent:updated,unsignedTransaction:prepareCeloTransfer(updated),nextAction:"wallet_signature_required" });
    }
    if (intent.status === "confirmed") {
      const invoiceSynced = await markCeloInvoiceSettled(ctx.payment.id,ctx.workspaceId,intent.txHash).catch(()=>false);
      return res.status(200).json({ok:true,intent,idempotent:true,invoiceSynced});
    }
    if (intent.status !== "approved" || Date.now() >= new Date(intent.expiresAt).getTime()) {
      throw Object.assign(new Error("Proposal is not approved or has expired"),{status:409});
    }
    const verification = await verifyCeloPayment(intent,body.txHash,intent.approvedAt);
    if (verification.pending) return res.status(202).json({ok:false,status:"pending",...verification});
    const updated = await recordV2Confirmation(ctx.actorId,id,verification);
    if (!updated) throw Object.assign(new Error("Payment changed state; reload"),{status:409});
    await addAuditEvent(ctx.payment.id,"celo_v2_confirmed",ctx.identity,{
      intent_id:id,network:"celo",tx_hash:verification.txHash,token:intent.token,
      amount:intent.amount,recipient:intent.recipient,workspace_id:ctx.workspaceId
    });
    const invoiceSynced = await markCeloInvoiceSettled(ctx.payment.id,ctx.workspaceId,verification.txHash).catch(()=>false);
    return res.status(200).json({ok:true,intent:updated,verification,invoiceSynced});
  } catch(err) { return errorJson(res,err); }
}

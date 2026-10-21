import { requireAgent, requireHumanApproval } from "./agent-v2-auth.js";
import { normalizeCeloProposal, prepareCeloTransfer, verifyCeloPayment } from "./celo-v2.js";
import { proposeV2Intent, getV2Intent, approveV2Intent, recordV2Confirmation } from "./agent-v2-store.js";

const TOOLS = [
  { name: "celo_payment_propose", method: "POST", operation: "propose", description: "Prepare an approval-required stablecoin transfer to an exact Celo recipient." },
  { name: "celo_payment_get", method: "GET", operation: "intent", description: "Read a proposal or signed-transfer status by its ID." },
  { name: "celo_payment_approve", method: "POST", operation: "approve", description: "Human-authorized approval using a separate, privileged credential." },
  { name: "celo_payment_confirm", method: "POST", operation: "confirm", description: "Reconcile an externally wallet-signed and mined ERC-20 transfer against the approved proposal." }
];
function errorStatus(error) {
  if (error?.status) return error.status;
  if (/DATABASE_URL|required|not configured|config/i.test(String(error?.message))) return 503;
  if (/idempotency|already assigned/i.test(String(error?.message))) return 409;
  if (/uuid|invalid input syntax/i.test(String(error?.message))) return 400;
  return 400;
}
function safeId(value) {
  const id = String(value || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid intent id");
  return id;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const operation = String(req.query?.operation || "tools").toLowerCase();
  if (operation === "tools" && req.method === "GET") {
    return res.status(200).json({ name: "33JACK V2 Agent Payments", network: "Celo Mainnet", tools: TOOLS, automaticExecution: false });
  }
  const actor = requireAgent(req);
  if (actor.error) return res.status(actor.status).json({ error: actor.error });
  try {
    if (operation === "propose" && req.method === "POST") {
      const idempotency = String(req.headers["idempotency-key"] || "").trim();
      if (!/^[a-zA-Z0-9_.:-]{8,128}$/.test(idempotency)) return res.status(400).json({ error: "Idempotency-Key header (8-128 safe characters) is required" });
      const proposal = normalizeCeloProposal(req.body || {});
      if (!proposal.payer) return res.status(400).json({error:"Agent proposals must bind the exact payer wallet"});
      const result = await proposeV2Intent(actor.agentId, proposal, idempotency);
      return res.status(result.created ? 201 : 200).json({ ok: true, ...result, nextAction: "human_approval_required" });
    }
    if (operation === "intent" && req.method === "GET") {
      const intent = await getV2Intent(actor.agentId, safeId(req.query?.id));
      if (!intent) return res.status(404).json({ error: "Intent not found" });
      const tx = intent.status === "approved" ? prepareCeloTransfer(intent) : null;
      return res.status(200).json({ ok: true, intent, unsignedTransaction: tx });
    }
    if (operation === "approve" && req.method === "POST") {
      const approval = requireHumanApproval(req);
      if (approval.error) return res.status(approval.status).json({ error: approval.error });
      const id = safeId(req.body?.id);
      if (req.body?.confirmation !== "APPROVE:" + id) return res.status(400).json({ error: "Explicit approval confirmation does not match intent" });
      const intent = await approveV2Intent(actor.agentId, id, approval.operatorId || "legacy-api-key");
      if (!intent) return res.status(409).json({ error: "Proposal was not found, has expired, or cannot be approved" });
      return res.status(200).json({ ok: true, intent, unsignedTransaction: prepareCeloTransfer(intent), nextAction: "wallet_signature_required" });
    }
    if (operation === "confirm" && req.method === "POST") {
      const id = safeId(req.body?.id);
      const intent = await getV2Intent(actor.agentId, id);
      if (!intent) return res.status(404).json({ error: "Intent not found" });
      if (intent.status === "confirmed") return res.status(200).json({ ok: true, intent, idempotent: true });
      if (intent.status !== "approved" || new Date(intent.expiresAt).getTime() <= Date.now()) {
        return res.status(409).json({ error: "Payment is not approved or approval expired" });
      }
      const verification = await verifyCeloPayment(intent, req.body?.txHash, intent.approvedAt);
      if (verification.pending) return res.status(202).json({ ok: false, status: "pending", ...verification });
      const updated = await recordV2Confirmation(actor.agentId, id, verification);
      if (!updated) return res.status(409).json({ error: "Payment changed state; reload the intent" });
      return res.status(200).json({ ok: true, intent: updated, verification });
    }
    return res.status(405).json({ error: "Unsupported operation or method", tools: TOOLS });
  } catch (error) {
    const status = errorStatus(error);
    // No secrets are included in client responses; do not expose database/RPC internals.
    const detail = status === 503 ? "Database or agent payment configuration unavailable" :
      error.message || "Celo agent payment failed";
    return res.status(status).json({ ok: false, error: detail });
  }
}

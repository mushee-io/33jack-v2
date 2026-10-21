import {gateLegacy} from "./_lib/legacy-access.js";
import {
  executeDemoSettlement,
  getSettlementRegistry,
  quoteSettlementRoutes
} from "./_lib/settlement.js";

export default async function handler(req, res) {
  if (!gateLegacy(req,res)) return;
  if (process.env.NODE_ENV !== "test" && process.env.JACK_ENABLE_LEGACY_SANDBOX !== "true") return res.status(410).json({error:"Legacy sandbox payment workflows are disabled on V2. Use Celo wallet-signed mainnet checkout."});

  const action = String(req.query?.action || "").toLowerCase();

  if (action === "health") {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const registry = getSettlementRegistry();
    return res.status(200).json({
      ok: true,
      mode: "demo",
      generatedAt: new Date().toISOString(),
      networks: registry.networks,
      providers: registry.providers
    });
  }

  if (action === "quote") {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        mode: "demo",
        registry: getSettlementRegistry()
      });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const quote = quoteSettlementRoutes(req.body || {});
      return res.status(200).json({ ok: true, ...quote });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: "Settlement quote failed",
        detail: error?.message || "Unable to prepare settlement routes"
      });
    }
  }

  if (action === "execute") {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const body = req.body || {};
      const quote = body.quote || quoteSettlementRoutes(body.paymentIntent || {});
      const result = executeDemoSettlement({
        quote,
        routeId: body.routeId,
        approved: body.approved === true
      });
      return res
        .status(result.ok ? 200 : result.status === "awaiting_approval" ? 409 : 400)
        .json(result);
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: "Settlement execution failed",
        detail: error?.message || "Unable to execute settlement"
      });
    }
  }

  return res.status(400).json({
    error: "Unknown settlement action",
    detail: "Use action=health, action=quote, or action=execute"
  });
}

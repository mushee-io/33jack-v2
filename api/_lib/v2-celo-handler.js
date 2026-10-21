import { CELO_NETWORK, CELO_TOKENS, celoHealth } from "./celo-v2.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const operation = String(req.query?.operation || "config");
  if (!["config", "health"].includes(operation)) return res.status(400).json({ error: "Unknown operation" });
  const config = { ok: true, network: CELO_NETWORK, tokens: Object.values(CELO_TOKENS), mode: "wallet-signed-mainnet", backendCustody: false };
  if (operation === "config") return res.status(200).json(config);
  try {
    const health = await celoHealth();
    return res.status(200).json({ ...config, rpc: health });
  } catch {
    return res.status(503).json({ ...config, ok: false, rpc: { reachable: false }, error: "Celo RPC is unavailable" });
  }
}

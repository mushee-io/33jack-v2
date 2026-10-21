import agentHandler from "./_lib/v2-agent-handler.js";
import authHandler from "./_lib/v2-auth-handler.js";
import mcpHandler from "./_lib/v2-mcp-handler.js";
import a2aHandler from "./_lib/v2-a2a-handler.js";
import receiptHandler from "./_lib/v2-receipt-handler.js";
import policyHandler from "./_lib/v2-policy-handler.js";
import inboxHandler from "./_lib/v2-inbox-handler.js";
import channelHandler from "./_lib/v2-channel-handler.js";
import celoHandler from "./_lib/v2-celo-handler.js";

// Consolidated router keeps 33JACK on Vercel Hobby's 12-function limit.
// Existing /api/v2/agent, /api/v2/channel, /api/v2/celo URLs are preserved.
const handlers = Object.freeze({agent: agentHandler, channel: channelHandler, celo: celoHandler, auth: authHandler, mcp: mcpHandler, a2a: a2aHandler, receipt: receiptHandler, policy: policyHandler, inbox: inboxHandler});
export default async function handler(req, res) {
  const target = String(req.query?.resource || "");
  if (!Object.hasOwn(handlers, target)) return res.status(404).json({error:"Unknown V2 API resource"});
  return handlers[target](req, res);
}

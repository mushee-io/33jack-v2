import { createHash, timingSafeEqual } from "node:crypto";
import {requireOperator} from "./operator-auth.js";

function safeCompare(candidate, expected) {
  const a = createHash("sha256").update(String(candidate || "")).digest();
  const b = createHash("sha256").update(String(expected || "")).digest();
  return timingSafeEqual(a, b);
}

export function requireAgent(req) {
  const raw = String(process.env.JACK_AGENT_API_KEYS_JSON || "").trim();
  if (!raw) return { error: "Agent API is not configured", status: 503 };
  let agents;
  try { agents = JSON.parse(raw); } catch { return { error: "Agent API key config is invalid", status: 503 }; }
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return { error: "Agent API key config is invalid", status: 503 };
  const agentId = String(req.headers["x-jack-agent-id"] || "").trim();
  const bearer = String(req.headers.authorization || "").match(/^Bearer (.+)$/i)?.[1] || "";
  const key = agents[agentId];
  if (!agentId || !/^[a-z0-9_-]{2,64}$/i.test(agentId) || typeof key !== "string" || key.length < 32 || !safeCompare(bearer, key)) {
    return { error: "Agent authentication failed", status: 401 };
  }
  return { agentId };
}

export function requireHumanApproval(req) {
  const operator = requireOperator(req,["owner","admin","approver"]);
  if (operator.actor) return { allowed:true,operatorId:operator.actor.id,role:operator.actor.role,workspaceId:operator.actor.workspaceId };
  if (process.env.JACK_ALLOW_LEGACY_APPROVAL_KEY !== "true") return operator;
  const configured = String(process.env.JACK_APPROVAL_API_KEY || "");
  const supplied = String(req.headers["x-jack-approval-key"] || "");
  if (configured.length < 32) return { error: "Human approval key not configured", status: 503 };
  if (!supplied || !safeCompare(supplied, configured)) return { error: "Human approval credential required", status: 403 };
  try {
    const agents = JSON.parse(process.env.JACK_AGENT_API_KEYS_JSON || "{}");
    if (Object.values(agents).some((value) => safeCompare(value, configured))) {
      return { error: "Approval and agent credentials must be separate", status: 503 };
    }
  } catch { return { error: "Agent key configuration invalid", status: 503 }; }
  return {allowed:true,operatorId:"legacy-api-key"};
}

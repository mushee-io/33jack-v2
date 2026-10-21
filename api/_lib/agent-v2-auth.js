import { createHash, timingSafeEqual, createHmac, randomBytes } from "node:crypto";
import {requireOperator} from "./operator-auth.js";

function safeCompare(candidate, expected) {
  const a = createHash("sha256").update(String(candidate || "")).digest();
  const b = createHash("sha256").update(String(expected || "")).digest();
  return timingSafeEqual(a, b);
}

export function mintAgentToken(agentId,hours=24){
 const secret=String(process.env.JACK_AGENT_TOKEN_SECRET||"");
 if(secret.length<48)throw Object.assign(new Error("Agent signing key not configured"),{status:503});
 if(!/^[a-z0-9_-]{2,64}$/i.test(String(agentId||""))||/^(?:channel_|operator_)/i.test(String(agentId)))throw Object.assign(new Error("Invalid or reserved agent ID"),{status:400});
 if(!Number.isInteger(hours)||hours<1||hours>24)throw Object.assign(new Error("Agent credentials expire within 24 hours"),{status:400});
 const issued=Date.now(),claims={sub:agentId,iat:issued,exp:issued+hours*3600000,scope:"jack:agent",nonce:randomBytes(12).toString("hex")};
 const payload=Buffer.from(JSON.stringify(claims)).toString("base64url");
 const signed="jack2."+payload;
 return {token:signed+"."+createHmac("sha256",secret).update(signed).digest("base64url"),expiresAt:new Date(claims.exp).toISOString()};
}
function verifySignedAgentToken(bearer,id){
 const secret=String(process.env.JACK_AGENT_TOKEN_SECRET||"");
 if(secret.length<48||!bearer.startsWith("jack2.")||bearer.length>1600)return null;
 const parts=bearer.split(".");if(parts.length!==3)return null;
 const expected=createHmac("sha256",secret).update(parts.slice(0,2).join(".")).digest("base64url");
 if(!safeCompare(expected,parts[2]))return null;
 let claims;try{claims=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));}catch{return null;}
 if(!claims||claims.sub!==id||claims.scope!=="jack:agent"||!Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(claims.iat))return null;
 if(claims.iat>Date.now()+60000||claims.exp<=Date.now()||claims.exp-claims.iat>86400000)return null;
 return {agentId:id,expiresAt:new Date(claims.exp).toISOString()};
}
export function requireAgent(req) {
 const agentId=String(req.headers?.["x-jack-agent-id"]||"").trim();
 const bearer=String(req.headers?.authorization||"").match(/^Bearer (.+)$/i)?.[1]||"";
 if(/^(?:channel_|operator_)/i.test(agentId))return {error:"Reserved agent ID",status:403};
 if(/^[a-z0-9_-]{2,64}$/i.test(agentId)&&bearer.startsWith("jack2.")){
  const signed=verifySignedAgentToken(bearer,agentId);
  return signed||{error:"Agent authentication failed",status:401};
 }

  const raw = String(process.env.JACK_AGENT_API_KEYS_JSON || "").trim();
  if (!raw) return { error: "Agent API is not configured", status: 503 };
  let agents;
  try { agents = JSON.parse(raw); } catch { return { error: "Agent API key config is invalid", status: 503 }; }
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return { error: "Agent API key config is invalid", status: 503 };
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

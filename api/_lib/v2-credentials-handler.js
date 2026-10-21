import {requireOperator} from "./operator-auth.js";
import {mintAgentToken} from "./agent-v2-auth.js";
import {getAgentPolicy} from "./agent-policy.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 if(req.method!=="POST")return res.status(405).json({error:"POST only"});
 const auth=requireOperator(req,["owner","admin"]);
 if(auth.error)return res.status(auth.status).json({error:auth.error});
 if(Number(req.headers?.["content-length"]||0)>3000)return res.status(413).json({error:"Too large"});
 try{
  const agentId=String(req.body?.agentId||"").trim();
  if(!/^[a-z0-9_-]{2,64}$/i.test(agentId)||/^(?:channel_|operator_)/i.test(agentId))return res.status(400).json({error:"Valid external agent ID required"});
  const configured=await getAgentPolicy(agentId);
  if(configured?.policy?.enabled!==true)return res.status(409).json({error:"Configure and enable an agent spending policy first"});
  const credential=mintAgentToken(agentId,Number(req.body?.hours??24));
  return res.status(201).json({ok:true,agentId,credential:credential.token,expiresAt:credential.expiresAt,
   notice:"Shown once. Server-side use only. Max 24h. To revoke immediately rotate JACK_AGENT_TOKEN_SECRET; otherwise wait for expiry."});
 }catch(e){return res.status(e.status||503).json({error:e.status===400?e.message:"Agent credentials unavailable"});}
}
import {requireAgent} from "./agent-v2-auth.js";
import {requireOperator} from "./operator-auth.js";
import {getAgentPolicy,setAgentPolicy,evaluateAgentPolicy} from "./agent-policy.js";
import {normalizeCeloProposal} from "./celo-v2.js";
const agentIdOk=id=>/^[a-z0-9_-]{2,64}$/i.test(String(id||""));
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 const op=String(req.query?.operation||"get");
 try{
  if(op==="configure"&&req.method==="POST"){
   const auth=requireOperator(req,["owner","admin"]);if(auth.error)return res.status(auth.status).json({error:auth.error});
   const id=String(req.body?.agentId||"");if(!agentIdOk(id))return res.status(400).json({error:"Invalid agent ID"});
   const policy=await setAgentPolicy(id,req.body?.policy,auth.actor.id);
   return res.status(200).json({ok:true,agentId:id,policy,updatedBy:auth.actor.id});
  }
  const agent=requireAgent(req);if(agent.error)return res.status(agent.status).json({error:agent.error});
  if(op==="get"&&req.method==="GET"){
   const row=await getAgentPolicy(agent.agentId);return res.status(200).json({ok:true,agentId:agent.agentId,policy:row?.policy||null,updatedAt:row?.updated_at||null});
  }
  if(op==="check"&&req.method==="POST"){
   const proposal=normalizeCeloProposal(req.body||{});
   const policy=await getAgentPolicy(agent.agentId);
   return res.status(200).json({ok:true,check:evaluateAgentPolicy(policy?.policy,proposal)});
  }
  return res.status(405).json({error:"Unsupported policy operation"});
 }catch(e){return res.status(e.status||503).json({error:e.status===400?e.message:"Policy service unavailable"});}
}

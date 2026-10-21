import {requireAgent} from "./agent-v2-auth.js";
import {getV2Intent} from "./agent-v2-store.js";
import {receiptFromIntent} from "./agent-finance-tools.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET")return res.status(405).json({error:"GET required"});
 const agent=requireAgent(req);if(agent.error)return res.status(agent.status).json({error:agent.error});
 try{const id=String(req.query?.id||"");if(!/^[a-f0-9-]{36}$/i.test(id))return res.status(400).json({error:"Invalid receipt ID"});
 const intent=await getV2Intent(agent.agentId,id);if(!intent)return res.status(404).json({error:"Payment intent not found"});
 return res.status(200).json({ok:true,receipt:receiptFromIntent(intent)});
 }catch(e){return res.status(e.status||503).json({error:e.status===409?e.message:"Receipt unavailable"});}
}

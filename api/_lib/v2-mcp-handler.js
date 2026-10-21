import {PAYMENT_TOOLS,runAgentPaymentTool} from "./agent-finance-tools.js";
const VERSIONS=["2026-07-28","2025-11-25","2025-06-18"];
const error=(id,code,message)=>({jsonrpc:"2.0",id:id??null,error:{code,message}});
export default async function handler(req,res) {
 res.setHeader("Cache-Control","no-store");res.setHeader("X-Content-Type-Options","nosniff");
 if(req.method!=="POST")return res.status(405).json({error:"MCP uses HTTP POST JSON-RPC"});
 const origin=req.headers?.origin;
 if(origin){try{const u=new URL(origin);if(u.protocol!=="https:"||u.host!==String(req.headers?.["x-forwarded-host"]||req.headers?.host||""))return res.status(403).json(error(null,-32000,"Origin rejected"));}catch{return res.status(403).json(error(null,-32000,"Origin rejected"));}}
 if(Number(req.headers?.["content-length"]||0)>24000)return res.status(413).json(error(null,-32600,"Request too large"));
 const msg=req.body||{},id=msg.id;
 if(msg.jsonrpc!=="2.0"||typeof msg.method!=="string"||Array.isArray(req.body))return res.status(400).json(error(id,-32600,"Invalid JSON-RPC request"));
 if(msg.method==="notifications/initialized")return res.status(202).end();
 try{
  let result;
  if(msg.method==="initialize")result={protocolVersion:VERSIONS.includes(msg.params?.protocolVersion)?msg.params.protocolVersion:VERSIONS[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:"33jack-v2-celo-finance",version:"0.3.0"},instructions:"Never ask an agent to disclose payment secrets; all transfers need separately authenticated human approval and wallet signatures."};
  else if(msg.method==="ping")result={};
  else if(msg.method==="tools/list")result={tools:PAYMENT_TOOLS};
  else if(msg.method==="tools/call"){
   const name=String(msg.params?.name||"");
   const data=await runAgentPaymentTool(req,name,msg.params?.arguments||{});
   result={content:[{type:"text",text:JSON.stringify(data)}],structuredContent:data,isError:false};
  } else return res.status(200).json(error(id,-32601,"Method not found"));
  return res.status(200).json({jsonrpc:"2.0",id,result});
 }catch(e){
  if(msg.method==="tools/call")return res.status(200).json({jsonrpc:"2.0",id,result:{content:[{type:"text",text:e.status===503?"Finance service unavailable":String(e.message||"Tool failed")}],isError:true}});
  return res.status(200).json(error(id,-32603,"Internal error"));
 }
}

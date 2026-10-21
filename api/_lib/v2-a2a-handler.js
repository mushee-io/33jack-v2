import {randomUUID} from "node:crypto";
import {PAYMENT_TOOLS,runAgentPaymentTool} from "./agent-finance-tools.js";
function card(req) {
 const domain=String(process.env.PUBLIC_APP_URL||"https://33jack-v2.vercel.app").replace(/\/$/,"");
 return {name:"33JACK Finance Agent",description:"Noncustodial Celo business payment intent preparation, verified receipts and reconciliation, controlled by human approvals.",
  version:"0.3.0",url:domain+"/api/v2/a2a",protocolVersion:"0.3.0",supportedInterfaces:[{url:domain+"/api/v2/a2a",protocolBinding:"JSONRPC",protocolVersion:"0.3.0"}],
  provider:{organization:"Mushee",url:"https://mushee.xyz"},
  capabilities:{streaming:false,pushNotifications:false,stateTransitionHistory:false},
  defaultInputModes:["application/json"],defaultOutputModes:["application/json"],
  securitySchemes:{agentBearer:{type:"http",scheme:"bearer"}},
  security:[{agentBearer:[]}],
  skills:PAYMENT_TOOLS.map(t=>({id:t.name,name:t.name,description:t.description,tags:["celo","stablecoin","finance"],examples:["Use structured data parts to invoke "+t.name]}))};
}
const rpcError=(id,code,message)=>({jsonrpc:"2.0",id:id??null,error:{code,message}});
export default async function handler(req,res) {
 res.setHeader("Cache-Control","no-store");
 if(req.method==="GET"&&String(req.query?.operation||"card")==="card")return res.status(200).json(card(req));
 if(req.method!=="POST")return res.status(405).json({error:"POST required"});
 const msg=req.body||{},id=msg.id;
 if(msg.jsonrpc!=="2.0"||msg.method!=="message/send")return res.status(200).json(rpcError(id,-32601,"Only message/send is supported; async tasks are not advertised"));
 const message=msg.params?.message;
 const parts=message?.parts;
 if(!Array.isArray(parts)||parts.length!==1||typeof parts[0]?.data!=="object")
  return res.status(200).json(rpcError(id,-32602,"A2A requires exactly one structured data part; natural-language requests never execute payments"));
 const payload=parts[0].data;
 try {
  const result=await runAgentPaymentTool(req,String(payload.tool||""),payload.arguments||{});
  return res.status(200).json({jsonrpc:"2.0",id,result:{kind:"message",role:"agent",messageId:randomUUID(),contextId:message.contextId||undefined,parts:[{kind:"data",data:result}]}});
 }catch(e){return res.status(200).json(rpcError(id,e.status===401?-32001:-32000,String(e.message||"Agent service unavailable")));}
}

import {test} from "node:test";
import assert from "node:assert/strict";
import {scryptSync} from "node:crypto";
import {verifyTotp,signSession,getSession,requireLegacyAccess,requireOperator} from "../api/_lib/operator-auth.js";
import {normalizeAgentPolicy,evaluateAgentPolicy} from "../api/_lib/agent-policy.js";
import {normalizeCeloProposal} from "../api/_lib/celo-v2.js";
import {receiptFromIntent} from "../api/_lib/agent-finance-tools.js";
import {extractInboxInvoice} from "../api/_lib/v2-inbox-handler.js";
import {invoiceRiskScreen} from "../api/_lib/v2-x402-handler.js";
import mcpHandler from "../api/_lib/v2-mcp-handler.js";
import a2aHandler from "../api/_lib/v2-a2a-handler.js";
import cronHandler from "../api/_lib/v2-schedule-handler.js";
function invoke(handler,method,query={},body={},headers={}){
 return new Promise((resolve,reject)=>{const req={method,query,body,headers},res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(data){resolve({status:this.code,data,headers:this.headers});return this;},end(){resolve({status:this.code,data:null});}};Promise.resolve(handler(req,res)).catch(reject);});
}
test("MFA authentication, session integrity and blocked legacy finance access",()=>{
 const oldSecret=process.env.JACK_SESSION_SECRET,oldUsers=process.env.JACK_OPERATORS_JSON,oldScope=process.env.JACK_ADMIN_SCOPE;
 try{
  const salt="11".repeat(24),password="example-long-password";
  process.env.JACK_SESSION_SECRET="s".repeat(64);
  process.env.JACK_OPERATORS_JSON=JSON.stringify({owner:{role:"owner",workspaceId:"test",passwordSalt:salt,passwordHash:scryptSync(password,Buffer.from(salt,"hex"),64).toString("hex"),totpSecret:"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}});
  delete process.env.JACK_ADMIN_SCOPE;
  assert.equal(verifyTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","287082",59000),true);
  const signed=signSession({id:"owner",role:"owner",workspaceId:"test"});
  assert.equal(getSession({headers:{cookie:"__Host-jack_session="+signed}}).id,"owner");
  assert.equal(getSession({headers:{cookie:"__Host-jack_session="+signed+"tamper"}}),null);
  assert.equal(requireOperator({method:"GET",headers:{}}).status,401);
  assert.equal(requireLegacyAccess({method:"GET",headers:{cookie:"__Host-jack_session="+signed}}).status,503);
 }finally{
  for(const [key,value] of [["JACK_SESSION_SECRET",oldSecret],["JACK_OPERATORS_JSON",oldUsers],["JACK_ADMIN_SCOPE",oldScope]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
test("agent policies enforce exact beneficiaries and aggregate daily budgets",()=>{
 const payer="0x"+"2".repeat(40),recipient="0x"+"1".repeat(40),other="0x"+"3".repeat(40);
 const p=normalizeAgentPolicy({enabled:true,authorization:"human-and-wallet",payers:[payer],recipients:[recipient],tokens:["USDC"],maxPerPayment:"80",maxPerDay:"100"});
 const payment=normalizeCeloProposal({token:"USDC",amount:"50",payer,recipient});
 assert.equal(evaluateAgentPolicy(p,payment).allowed,true);
 assert.match(evaluateAgentPolicy(p,{...payment,recipient:other}).reason,/Recipient/);
 assert.match(evaluateAgentPolicy(p,payment,[{amount_units:"60000000",decimals:6}]).reason,/daily/);
 assert.equal(evaluateAgentPolicy(null,payment).allowed,false);
});
test("receipts and invoice screening never imply unverified settlement",()=>{
 assert.throws(()=>receiptFromIntent({status:"approved"}),/unavailable/);
 const i={id:"11111111-1111-1111-1111-111111111111",status:"confirmed",txHash:"0x"+"a".repeat(64),verification:{logIndex:"0x0",confirmations:3},payer:"0x"+"2".repeat(40),recipient:"0x"+"1".repeat(40),token:"USDC",tokenAddress:"0x"+"a".repeat(40),amount:"1",amountUnits:"1000000"};
 assert.equal(receiptFromIntent(i).receiptId,receiptFromIntent(i).receiptId);
 const email=extractInboxInvoice({id:"ab",snippet:"Invoice",payload:{headers:[{name:"Subject",value:"Invoice #INV-2026"},{name:"From",value:"invoice@example.com"}],mimeType:"text/plain",body:{data:Buffer.from("Amount due: USD 15.00").toString("base64url")}}});
 assert.equal(email.risk.auto_payment_forbidden,true);
 assert.equal(email.currency,"USD");
 assert.equal(invoiceRiskScreen({}).settlementAllowed,false);
});
test("MCP discovery and A2A card work without granting agent execution",async()=>{
 const init=await invoke(mcpHandler,"POST",{},{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2026-07-28"}});
 assert.equal(init.data.result.serverInfo.name,"33jack-v2-celo-finance");
 const list=await invoke(mcpHandler,"POST",{},{jsonrpc:"2.0",id:2,method:"tools/list"});
 assert.equal(list.data.result.tools.length,4);
 const denied=await invoke(mcpHandler,"POST",{},{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"celo_payment_get",arguments:{id:"11111111-1111-1111-1111-111111111111"}}});
 assert.equal(denied.data.result.isError,true);
 const card=await invoke(a2aHandler,"GET",{operation:"card"});
 assert.ok(card.data.skills.some(x=>x.id==="celo_payment_propose"));
 const cron=await invoke(cronHandler,"GET",{operation:"runDue"});
 assert.equal(cron.status,401);
});

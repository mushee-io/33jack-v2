import {test} from "node:test";
import assert from "node:assert/strict";
import {signSession} from "../api/_lib/operator-auth.js";
import operatorHandler from "../api/_lib/v2-operator-payment-handler.js";
import {requireAgent,mintAgentToken} from "../api/_lib/agent-v2-auth.js";
import {setAgentPolicy} from "../api/_lib/agent-policy.js";
import {normalizeCeloProposal} from "../api/_lib/celo-v2.js";

async function invoke(handler,method,operation,body,headers={}){
 const req={method,body,query:{operation},headers};
 let answer=null;
 const res={statusCode:200,setHeader(){return this;},status(code){this.statusCode=code;return this;},json(value){answer={status:this.statusCode,data:value};return this;},end(){answer={status:this.statusCode,data:null};return this;}};
 await handler(req,res);
 return answer;
}
test("first-party checkout cannot be used without MFA",async()=>{
 const reqs=[
  ["GET","readiness"],["POST","propose"],["POST","approve"],["POST","confirm"],["GET","receipt"],["GET","intent"]
 ];
 for(const [method,operation] of reqs){
  const result=await invoke(operatorHandler,method,operation,{});
  assert.equal(result.status,401,operation);
 }
});
test("operator wallet checkout validates exact terms and origin before accessing database",async()=>{
 const save={session:process.env.JACK_SESSION_SECRET,db:process.env.JACK_OPERATOR_DB_AUTH,workspace:process.env.JACK_PRIMARY_WORKSPACE_ID};
 try{
  process.env.JACK_SESSION_SECRET="c".repeat(64);
  process.env.JACK_OPERATOR_DB_AUTH="true";
  process.env.JACK_PRIMARY_WORKSPACE_ID="ws_checkout_test";
  const cookie="__Host-jack_session="+signSession({id:"owner",role:"owner",workspaceId:"ws_checkout_test"});
  const headers={cookie,host:"app.example.com",origin:"https://app.example.com"};
  const noRecipient=await invoke(operatorHandler,"POST","propose",{token:"USDC",amount:"1",payer:"0x"+"2".repeat(40)},headers);
  assert.equal(noRecipient.status,400);
  assert.match(noRecipient.data.error,/recipient/);
  const noIntent=await invoke(operatorHandler,"GET","intent",{},headers);
  assert.equal(noIntent.status,400);
  const deniedOrigin=await invoke(operatorHandler,"POST","propose",{}, {...headers,origin:"https://evil.example.com"});
  assert.equal(deniedOrigin.status,403);
  const wrongWorkspaceCookie="__Host-jack_session="+signSession({id:"owner",role:"owner",workspaceId:"ws_someone_else"});
  const crossWorkspace=await invoke(operatorHandler,"POST","propose",{}, {...headers,cookie:wrongWorkspaceCookie});
  assert.equal(crossWorkspace.status,403);
 }finally{
  for(const [key,value] of [["JACK_SESSION_SECRET",save.session],["JACK_OPERATOR_DB_AUTH",save.db],["JACK_PRIMARY_WORKSPACE_ID",save.workspace]])if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
});
test("owner namespace cannot be assigned to any external agent",async()=>{
 const saved=process.env.JACK_AGENT_TOKEN_SECRET;
 try{
  process.env.JACK_AGENT_TOKEN_SECRET="k".repeat(64);
  assert.throws(()=>mintAgentToken("operator_ws_checkout_test",1),/reserved/);
  assert.throws(()=>mintAgentToken("channel_chat",1),/reserved/);
  await assert.rejects(setAgentPolicy("operator_ws_checkout_test",{}, "owner"),/Invalid external agent ID/);
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"operator_ws_checkout_test",authorization:"Bearer test"}}).status,403);
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"channel_chat",authorization:"Bearer test"}}).status,403);
 }finally{
  if(saved===undefined)delete process.env.JACK_AGENT_TOKEN_SECRET;else process.env.JACK_AGENT_TOKEN_SECRET=saved;
 }
});
test("Celo checkout refuses zero/unknown token wallets and never produces a private key",()=>{
 assert.throws(()=>normalizeCeloProposal({token:"USDC",amount:"1",payer:"0x"+"2".repeat(40),recipient:"0x"+"0".repeat(40)}),/zero address/);
 const proposal=normalizeCeloProposal({token:"USDC",amount:"0.01",payer:"0x"+"2".repeat(40),recipient:"0x"+"1".repeat(40)});
 assert.equal(proposal.amountUnits,"10000");
 assert.equal(Object.hasOwn(proposal,"privateKey"),false);
});

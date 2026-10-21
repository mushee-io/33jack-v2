import {test} from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {mintAgentToken,requireAgent} from "../api/_lib/agent-v2-auth.js";
import {bootstrapOperator,operatorEnrollmentStatus,getSession,signSession,requireOperator} from "../api/_lib/operator-auth.js";
import authHandler from "../api/_lib/v2-auth-handler.js";

function invoke(handler,method,query={},body={},headers={}){
 return new Promise((resolve,reject)=>{
  const request={method,query,body,headers};
  const response={code:200,headers:{},setHeader(k,v){this.headers[k]=v;return this;},status(n){this.code=n;return this;},json(data){resolve({status:this.code,data,headers:this.headers});return this;},end(){resolve({status:this.code,data:null});}};
  Promise.resolve(handler(request,response)).catch(reject);
 });
}
function withEnv(key,value,fn){
 const old=process.env[key];
 if(value===null)delete process.env[key];else process.env[key]=value;
 try{return fn();}finally{if(old===undefined)delete process.env[key];else process.env[key]=old;}
}
test("short-lived external agent tokens are unique, agent-bound and secret-signed",()=>{
 withEnv("JACK_AGENT_TOKEN_SECRET","x".repeat(96),()=>{
  const one=mintAgentToken("external_partner",1),two=mintAgentToken("external_partner",1);
  assert.notEqual(one.token,two.token);
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"external_partner",authorization:"Bearer "+one.token}}).agentId,"external_partner");
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"wrong_partner",authorization:"Bearer "+one.token}}).status,401);
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"external_partner",authorization:"Bearer "+one.token+"bad"}}).status,401);
  assert.throws(()=>mintAgentToken("external_partner",25),/24 hours/);
  assert.throws(()=>mintAgentToken("external_partner",0),/24 hours/);
  const segments=one.token.split("."),signed="jack2."+segments[1];
  const expired=Buffer.from(JSON.stringify({sub:"external_partner",scope:"jack:agent",iat:Date.now()-3600000,exp:Date.now()-1})).toString("base64url");
  const short="jack2."+expired;
  const token=short+"."+createHmac("sha256","x".repeat(96)).update(short).digest("base64url");
  assert.equal(requireAgent({headers:{"x-jack-agent-id":"external_partner",authorization:"Bearer "+token}}).status,401);
 });
});
test("operator registration cannot bootstrap without explicit configured secret",async()=>{
 const old=process.env.JACK_OPERATOR_DB_AUTH;
 try{
  delete process.env.JACK_OPERATOR_DB_AUTH;
  const out=await bootstrapOperator({method:"POST",headers:{}},{operatorId:"owner",password:"longvalidpassword"}, "start");
  assert.equal(out.status,503);
  assert.deepEqual(await operatorEnrollmentStatus(),{configured:false,enrolled:false});
  const status=await invoke(authHandler,"GET",{operation:"bootstrap-status"});
  assert.equal(status.status,200);
  assert.equal(status.data.configured,false);
 }finally{
  if(old===undefined)delete process.env.JACK_OPERATOR_DB_AUTH;else process.env.JACK_OPERATOR_DB_AUTH=old;
 }
});
test("MFA session cookie cannot be forged and origin checks block cross-site mutations",()=>{
 withEnv("JACK_SESSION_SECRET","k".repeat(64),()=>withEnv("JACK_OPERATOR_DB_AUTH","true",()=>{
  const actor={id:"owner",role:"owner",workspaceId:"ws_33jack_v2"};
  const signed=signSession(actor);
  assert.deepEqual(getSession({headers:{cookie:"__Host-jack_session="+signed}}),actor);
  assert.equal(getSession({headers:{cookie:"__Host-jack_session="+signed+"garbage"}}),null);
  assert.equal(requireOperator({method:"POST",headers:{cookie:"__Host-jack_session="+signed,origin:"https://attacker.example",host:"33jack-v2.vercel.app"}}).status,403);
  assert.equal(requireOperator({method:"POST",headers:{cookie:"__Host-jack_session="+signed,origin:"https://33jack-v2.vercel.app",host:"33jack-v2.vercel.app"}}).actor.id,"owner");
  }));
});

/** 33JACK V2 server-side SDK; never ship agent API keys in frontend bundles. */
export class JackClient {
 constructor({baseUrl="https://33jack-v2.vercel.app",agentId,apiKey,fetcher=fetch}={}){
  if(!baseUrl.startsWith("https://")||!agentId||!apiKey)throw Error("HTTPS, agentId and apiKey required");
  this.origin=baseUrl.replace(/\/$/,"");this.agentId=agentId;this.apiKey=apiKey;this.fetcher=fetcher;
 }
 async request(path,{method="GET",body,idempotencyKey}={}){
  const headers={"x-jack-agent-id":this.agentId,Authorization:"Bearer "+this.apiKey};
  if(body!==undefined)headers["Content-Type"]="application/json";
  if(idempotencyKey)headers["Idempotency-Key"]=idempotencyKey;
  const r=await this.fetcher(this.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!r.ok){const error=new Error(data.error||"33JACK unavailable");error.status=r.status;throw error;}
  return data;
 }
 propose({token="USDC",amount,payer,recipient,memo="",idempotencyKey}){return this.request("/api/v2/agent?operation=propose",{method:"POST",idempotencyKey,body:{token,amount,payer,recipient,memo}});}
 intent(id){return this.request("/api/v2/agent?operation=intent&id="+encodeURIComponent(id));}
 confirm(id,txHash){return this.request("/api/v2/agent?operation=confirm",{method:"POST",body:{id,txHash}});}
 receipt(id){return this.request("/api/v2/receipt?id="+encodeURIComponent(id));}
 policy(){return this.request("/api/v2/policy?operation=get");}
 checkPolicy(proposal){return this.request("/api/v2/policy?operation=check",{method:"POST",body:proposal});}
 mcp(name,args){return this.request("/api/v2/mcp",{method:"POST",body:{jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name,arguments:args}}});}
 a2a(name,args){const id=crypto.randomUUID();return this.request("/api/v2/a2a",{method:"POST",body:{jsonrpc:"2.0",id,method:"message/send",params:{message:{kind:"message",messageId:id,role:"user",parts:[{kind:"data",data:{tool:name,arguments:args}}]}}}});}
}

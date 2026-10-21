"""33JACK V2 server-side finance SDK. Never expose API keys to frontend users."""
import json
import urllib.parse
import urllib.request
import urllib.error
import uuid

class JackError(Exception):
    def __init__(self,message,status=None):
        super().__init__(message)
        self.status=status

class JackClient:
    def __init__(self,agent_id,api_key,base_url="https://33jack-v2.vercel.app"):
        if not base_url.startswith("https://") or not agent_id or not api_key:
            raise ValueError("HTTPS origin and credentials required")
        self.base_url=base_url.rstrip("/")
        self.agent_id=agent_id
        self.api_key=api_key
    def request(self,path,method="GET",body=None,idempotency_key=None):
        headers={"x-jack-agent-id":self.agent_id,"Authorization":"Bearer "+self.api_key}
        raw=None if body is None else json.dumps(body).encode()
        if raw is not None:headers["Content-Type"]="application/json"
        if idempotency_key:headers["Idempotency-Key"]=idempotency_key
        request=urllib.request.Request(self.base_url+path,data=raw,headers=headers,method=method)
        try:
            with urllib.request.urlopen(request,timeout=20) as response:return json.load(response)
        except urllib.error.HTTPError as error:
            try:message=json.load(error).get("error","33JACK error")
            except Exception:message="33JACK error"
            raise JackError(message,error.code) from error
    def propose(self,token,amount,payer,recipient,idempotency_key,memo=""):
        return self.request("/api/v2/agent?operation=propose","POST",{"token":token,"amount":amount,"payer":payer,"recipient":recipient,"memo":memo},idempotency_key)
    def intent(self,id):return self.request("/api/v2/agent?operation=intent&id="+urllib.parse.quote(id))
    def confirm(self,id,tx_hash):return self.request("/api/v2/agent?operation=confirm","POST",{"id":id,"txHash":tx_hash})
    def receipt(self,id):return self.request("/api/v2/receipt?id="+urllib.parse.quote(id))
    def policy(self):return self.request("/api/v2/policy?operation=get")
    def mcp(self,name,args):
        return self.request("/api/v2/mcp","POST",{"jsonrpc":"2.0","id":str(uuid.uuid4()),"method":"tools/call","params":{"name":name,"arguments":args}})
    def a2a(self,name,args):
        id=str(uuid.uuid4())
        return self.request("/api/v2/a2a","POST",{"jsonrpc":"2.0","id":id,"method":"message/send","params":{"message":{"kind":"message","messageId":id,"role":"user","parts":[{"kind":"data","data":{"tool":name,"arguments":args}}]}}})

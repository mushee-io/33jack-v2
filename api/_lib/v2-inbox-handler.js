import postgres from "postgres";
import {createHash} from "node:crypto";
import {requireOperator} from "./operator-auth.js";
let conn,schema;
function db(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("Database not configured"),{status:503});return conn ||= postgres(process.env.DATABASE_URL,{max:2,idle_timeout:20,connect_timeout:8});}
async function ready(){if(!schema)schema=db().unsafe("CREATE TABLE IF NOT EXISTS jack_v2_email_inbox (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,provider TEXT NOT NULL, sender TEXT,subject TEXT,snippet TEXT,invoice_ref TEXT,amount TEXT,currency TEXT,received_at TIMESTAMPTZ,status TEXT NOT NULL DEFAULT 'needs_review', risk_flags JSONB NOT NULL DEFAULT '{}'::jsonb,reviewed_by TEXT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(workspace_id,provider,id))").catch(e=>{schema=null;throw e});await schema;return db();}
function workspace(actor){const configured=String(process.env.JACK_EMAIL_WORKSPACE_ID||"");if(!configured)throw Object.assign(new Error("JACK_EMAIL_WORKSPACE_ID not configured"),{status:503});if(actor.workspaceId&&actor.workspaceId!==configured)throw Object.assign(new Error("Not authorised for this workspace"),{status:403});return configured;}
function base64Url(s){return Buffer.from(String(s||"").replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8");}
function textParts(node,depth=0){
 if(!node||depth>4)return "";if(node.mimeType==="text/plain"&&node.body?.data)return base64Url(node.body.data).slice(0,5000);
 if(Array.isArray(node.parts))return node.parts.map(p=>textParts(p,depth+1)).filter(Boolean).join("\n").slice(0,5000);
 return "";
}
export function extractInboxInvoice(message){
 const headers=message.payload?.headers||[];
 const header=name=>String(headers.find(h=>String(h.name||"").toLowerCase()===name)?.value||"").slice(0,300);
 const subject=header("subject"),sender=header("from"),body=textParts(message.payload),text=(subject+"\n"+body).slice(0,5500);
 const invoice=(text.match(/\b(?:invoice|bill)\s*(?:number|no\.?|#|ref(?:erence)?\.?)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,40})/i)||[])[1]||null;
 const money=text.match(/(?:\btotal(?:\s+due)?|\bamount\s+due|\bpayable)\s*[:\-]?\s*(USD|GBP|EUR|USDC|USDT|\$|£|€)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
 const currency=money?.[1]?({"$":"USD","£":"GBP","€":"EUR"}[money[1]]||money[1].toUpperCase()):null;
 const amount=money?money[2].replaceAll(",",""):null;
 const risk={unverified_sender:true,unverified_beneficiary:true,auto_payment_forbidden:true,missing_amount:!amount,missing_currency:!currency,missing_invoice_reference:!invoice};
 return{provider:"gmail",providerId:String(message.id||""),sender,subject,snippet:String(message.snippet||"").slice(0,300),invoiceRef:invoice,amount,currency,receivedAt:message.internalDate&&Number.isFinite(Number(message.internalDate))?new Date(Number(message.internalDate)).toISOString():new Date().toISOString(),risk};
}
async function gmailToken(){
 const id=process.env.GMAIL_CLIENT_ID,secret=process.env.GMAIL_CLIENT_SECRET,refresh=process.env.GMAIL_REFRESH_TOKEN;
 if(!id||!secret||!refresh)throw Object.assign(new Error("Gmail OAuth read-only connection not configured"),{status:503});
 const body=new URLSearchParams({client_id:id,client_secret:secret,refresh_token:refresh,grant_type:"refresh_token"});
 const res=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body,signal:AbortSignal.timeout(12000)});
 if(!res.ok)throw Object.assign(new Error("Gmail OAuth token refresh failed"),{status:502});
 const json=await res.json();if(!json.access_token)throw Error("Gmail did not issue access token");return json.access_token;
}
async function gmail(path,token){
 const response=await fetch("https://gmail.googleapis.com/gmail/v1/users/me/"+path,{headers:{"Authorization":"Bearer "+token},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Object.assign(new Error("Gmail API returned "+response.status),{status:502});return response.json();
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 const gate=requireOperator(req,["owner","admin","approver"]);if(gate.error)return res.status(gate.status).json({error:gate.error});
 const action=String(req.query?.operation||"list");
 try{
  const workspaceId=workspace(gate.actor),sql=await ready();
  if(action==="list"&&req.method==="GET"){
   const rows=await sql.unsafe("SELECT id,sender,subject,snippet,invoice_ref,amount,currency,received_at,status,risk_flags,reviewed_by FROM jack_v2_email_inbox WHERE workspace_id=$1 ORDER BY received_at DESC LIMIT 100",[workspaceId]);
   return res.status(200).json({ok:true,inbox:rows,mode:"review_only"});
  }
  if(action==="sync"&&req.method==="POST"){
   const token=await gmailToken();
   const list=await gmail("messages?maxResults=20&q="+encodeURIComponent("newer_than:14d (invoice OR receipt OR bill OR payment due)"),token);
   let imported=0;for(const item of (list.messages||[]).slice(0,20)){
    if(!/^[a-z0-9]+$/i.test(String(item.id||"")))continue;
    const msg=await gmail("messages/"+encodeURIComponent(item.id)+"?format=full",token);
    const row=extractInboxInvoice(msg);
    if(!row.providerId)continue;
    const dbId="gmail_"+createHash("sha256").update(workspaceId+":"+row.providerId).digest("hex");
    const result=await sql.unsafe("INSERT INTO jack_v2_email_inbox(id,workspace_id,provider,sender,subject,snippet,invoice_ref,amount,currency,received_at,risk_flags) VALUES($1,$2,'gmail',$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id",[dbId,workspaceId,row.sender,row.subject,row.snippet,row.invoiceRef,row.amount,row.currency,row.receivedAt,JSON.stringify(row.risk)]);
    imported+=result.length;
   }
   return res.status(200).json({ok:true,imported,scanned:(list.messages||[]).length,mode:"review_only",autoPayment:false});
  }
  if(action==="review"&&req.method==="POST"){
   const state=String(req.body?.decision||""),id=String(req.body?.id||"");
   if(!["accepted","rejected"].includes(state)||!/^gmail_[a-f0-9]{64}$/.test(id))return res.status(400).json({error:"Valid inbox ID and decision required"});
   const rows=await sql.unsafe("UPDATE jack_v2_email_inbox SET status=$3,reviewed_by=$4,updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND status='needs_review' RETURNING id,status,reviewed_by",[id,workspaceId,state,gate.actor.id]);
   return rows[0]?res.status(200).json({ok:true,item:rows[0]}):res.status(409).json({error:"Review item not found or already reviewed"});
  }
  return res.status(405).json({error:"Unsupported inbox operation"});
 }catch(e){return res.status(e.status||503).json({error:e.status===403?e.message:e.status===503?"Inbox integration unavailable":"Inbox operation failed"});}
}

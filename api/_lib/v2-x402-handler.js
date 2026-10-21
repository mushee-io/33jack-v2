import postgres from "postgres";
import {createHash} from "node:crypto";
import {CELO_TOKENS} from "./celo-v2.js";
let conn,schema;
function db(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("DATABASE_URL required for durable x402 settlement"),{status:503});return conn ||= postgres(process.env.DATABASE_URL,{max:2,idle_timeout:20,connect_timeout:8});}
async function ready(){if(!schema)schema=db().unsafe("CREATE TABLE IF NOT EXISTS jack_v2_x402_sales (payment_hash TEXT PRIMARY KEY, tx_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").catch(e=>{schema=null;throw e});await schema;return db();}
export function invoiceRiskScreen(input={}){
 const invoice=String(input.invoiceNumber||"").trim().slice(0,100);
 const supplier=String(input.supplier||"").trim().slice(0,180);
 const amount=String(input.amount||"").trim().slice(0,80);
 const currency=String(input.currency||"").trim().toUpperCase();
 const recipient=String(input.recipient||"").trim().toLowerCase();
 const missing=["invoiceNumber","supplier","amount","currency"].filter(k=>!String(input[k]??"").trim());
 const flags=[...missing.map(x=>"missing_"+x)];
 if(amount&&(!/^\d+(?:\.\d{1,8})?$/.test(amount)||Number(amount)<=0))flags.push("invalid_amount");
 if(currency&&!["USD","EUR","GBP","NGN","USDC","USDT","USDM"].includes(currency))flags.push("unrecognised_currency");
 if(recipient&&(!/^0x[a-f0-9]{40}$/.test(recipient)||/^0x0{40}$/.test(recipient)))flags.push("invalid_celo_recipient");
 if(!recipient)flags.push("unverified_beneficiary");
 const fingerprint=createHash("sha256").update(JSON.stringify([invoice.toLowerCase(),supplier.toLowerCase(),currency,amount,recipient])).digest("hex");
 return{schema:"33jack-risk-screen-v1",fingerprint,invoiceNumber:invoice||null,supplier:supplier||null,amount:amount||null,currency:currency||null,flags,manualReviewRequired:flags.length>0,settlementAllowed:false,details:"Deterministic validation only. No KYC, sanctions verification, duplicate database lookup or beneficiary ownership verification."};
}
function config(){
 const payTo=String(process.env.JACK_X402_RECEIVER||""),unit=String(process.env.JACK_X402_PRICE_UNITS||"10000"),url=String(process.env.JACK_X402_FACILITATOR_URL||"");
 if(!/^0x[a-f0-9]{40}$/i.test(payTo)||/^0x0{40}$/i.test(payTo)||!/^[1-9]\d{0,7}$/.test(unit)||!/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(url)||!process.env.JACK_X402_FACILITATOR_API_KEY)throw Object.assign(new Error("Production x402 facilitator, receiving wallet and price must be configured"),{status:503});
 return{payTo,unit,facilitator:url.replace(/\/$/,""),key:String(process.env.JACK_X402_FACILITATOR_API_KEY)};
}
function requirement(c){
 const resource={url:String(process.env.PUBLIC_APP_URL||"https://33jack-v2.vercel.app").replace(/\/$/,"")+"/api/v2/x402?operation=invoice-risk",description:"Deterministic invoice risk validation by 33JACK",mimeType:"application/json"};
 return{x402Version:2,resource,accepts:[{scheme:"exact",network:"eip155:42220",asset:CELO_TOKENS.USDC.address,amount:c.unit,payTo:c.payTo,maxTimeoutSeconds:120,extra:{}}]};
}
async function facilitator(c,path,payload){
 const res=await fetch(c.facilitator+path,{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":c.key},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 if(!res.ok)throw Object.assign(new Error("x402 facilitator unavailable"),{status:502});
 return res.json();
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 const op=String(req.query?.operation||"pricing");
 if(op==="pricing"&&req.method==="GET"){
  try{const c=config();return res.status(200).json({ok:true,requirement:requirement(c),resource:"invoice-risk",verified:false});}
  catch{return res.status(503).json({ok:false,error:"x402 mainnet facilitator not yet configured"});}
 }
 if(op!=="invoice-risk"||req.method!=="POST")return res.status(405).json({error:"Unsupported paid resource"});
 if(Number(req.headers?.["content-length"]||0)>16000)return res.status(413).json({error:"Body too large"});
 try{
  const c=config(),offer=requirement(c),signature=String(req.headers?.["payment-signature"]||"");
  if(!signature){res.setHeader("PAYMENT-REQUIRED",Buffer.from(JSON.stringify(offer)).toString("base64"));return res.status(402).json({error:"PAYMENT-REQUIRED",x402Version:2});}
  if(signature.length>16000||!/^[A-Za-z0-9+/=_-]+$/.test(signature))return res.status(400).json({error:"Invalid payment signature"});
  let paymentPayload;try{paymentPayload=JSON.parse(Buffer.from(signature,"base64").toString("utf8"));}catch{return res.status(400).json({error:"Malformed x402 payment payload"});}
  if(paymentPayload?.x402Version!==2)return res.status(402).json({error:"x402 version 2 is required"});
  const invoice=req.body?.invoice||{};
  if(!invoice||typeof invoice!=="object"||Array.isArray(invoice))return res.status(400).json({error:"Invoice object required"});
  const report=invoiceRiskScreen(invoice),sql=await ready();
  const paymentHash=createHash("sha256").update(signature).digest("hex");
  const requestHash=createHash("sha256").update(JSON.stringify(invoice)).digest("hex");
  const prior=await sql.unsafe("SELECT tx_hash,request_hash,result FROM jack_v2_x402_sales WHERE payment_hash=$1",[paymentHash]);
  if(prior.length){if(prior[0].request_hash!==requestHash)return res.status(409).json({error:"Payment cannot be reused for a different invoice"});return res.status(200).json({ok:true,cached:true,report,settlement:{transaction:prior[0].tx_hash,network:"eip155:42220"}});}
  const payload={x402Version:2,paymentPayload,paymentRequirements:offer.accepts[0]};
  const verify=await facilitator(c,"/verify",payload);
  if(verify?.isValid!==true)return res.status(402).json({error:"Facilitator rejected payment signature"});
  const settled=await facilitator(c,"/settle",payload);
  if(settled?.success!==true||!/^0x[a-f0-9]{64}$/i.test(String(settled.transaction||""))||settled.network!=="eip155:42220")
    return res.status(502).json({error:"Settlement is not conclusively confirmed; reconcile with facilitator before retry"});
  const rows=await sql.unsafe("INSERT INTO jack_v2_x402_sales(payment_hash,tx_hash,request_hash,result) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING payment_hash",[paymentHash,String(settled.transaction).toLowerCase(),requestHash,JSON.stringify(report)]);
  if(!rows.length)return res.status(409).json({error:"Payment transaction has already been consumed"});
  const receipt={success:true,transaction:settled.transaction,network:settled.network};
  res.setHeader("PAYMENT-RESPONSE",Buffer.from(JSON.stringify(receipt)).toString("base64"));
  return res.status(200).json({ok:true,report,settlement:receipt});
 }catch(e){return res.status(e.status||503).json({error:e.status===400?e.message:"x402 verification, persistence or facilitator unavailable"});}
}

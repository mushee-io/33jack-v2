/**
 * Human-operated wallet checkout for the primary workspace.
 * Different from the external-agent route: no bearer agent credential is
 * exposed to the browser. Human MFA and wallet signatures are still required.
 */
import {randomUUID} from "node:crypto";
import {requireOperator} from "./operator-auth.js";
import {normalizeCeloProposal,prepareCeloTransfer,verifyCeloPayment,celoHealth,CELO_NETWORK,CELO_TOKENS} from "./celo-v2.js";
import {ensureV2Store,proposeV2Intent,getV2Intent,approveV2Intent,recordV2Confirmation} from "./agent-v2-store.js";
import {receiptFromIntent} from "./agent-finance-tools.js";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function bad(message,status=400){const e=new Error(message);e.status=status;return e;}
function workspaceActor(session){
 const configured=String(process.env.JACK_PRIMARY_WORKSPACE_ID||"");
 if(!configured || session.workspaceId!==configured || !/^[a-z0-9_-]{4,64}$/i.test(configured))
  throw bad("Workspace enrolment does not match this deployment",403);
 return "operator_"+configured;
}
function safeId(id){if(!uuid.test(String(id||"")))throw bad("Valid proposal ID required");return String(id);}
function validateTerms(req,intent){
 if(req.body?.confirmation!=="APPROVE:"+intent.id)throw bad("Exact approval confirmation required");
 const submitted=req.body?.confirmTerms;
 if(!submitted || String(submitted.amount)!==String(intent.amount) ||
    String(submitted.token)!==String(intent.token) ||
    String(submitted.payer||"").toLowerCase()!==intent.payer ||
    String(submitted.recipient||"").toLowerCase()!==intent.recipient)
   throw bad("Human approval terms must match the exact proposal",409);
}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 const auth=requireOperator(req,["owner","admin","approver","viewer"]);
 if(auth.error)return res.status(auth.status).json({ok:false,error:auth.error});
 let actorId;
 try{actorId=workspaceActor(auth.actor);}catch(e){return res.status(e.status).json({error:e.message});}
 const op=String(req.query?.operation||"readiness").toLowerCase();
 try{
  if(op==="readiness" && req.method==="GET"){
   const [rpc,sql]=await Promise.all([celoHealth(),ensureV2Store()]);
   if(!rpc.correctNetwork)return res.status(503).json({ok:false,error:"RPC chain does not match Celo Mainnet"});
   const state=await sql.unsafe("SELECT COUNT(*)::int AS count FROM jack_v2_intents WHERE agent_id=$1",[actorId]);
   return res.status(200).json({ok:true,chain:CELO_NETWORK,assets:Object.values(CELO_TOKENS),
     database:"connected",rpc,ownerAccount:auth.actor.id,workspaceId:auth.actor.workspaceId,
     paymentIntents:state[0].count,canPrepare:["owner","admin"].includes(auth.actor.role),
     canApprove:["owner","admin","approver"].includes(auth.actor.role),
     testMode:"read_only",hasTransferredMoney:false,
     nextAction:"create_proposal_then_review_and_sign_with_your_own_wallet"});
  }
  if(op==="propose"&&req.method==="POST"){
   if(!["owner","admin"].includes(auth.actor.role))throw bad("Only owner/admin can prepare wallet payments",403);
   const proposal=normalizeCeloProposal(req.body||{});
   if(!proposal.payer)throw bad("Connected payer wallet is required");
   if(proposal.payer===proposal.recipient && req.body?.selfTransferAcknowledged!==true)
    throw bad("Confirm an intentional self-transfer before proposing");
   const key=String(req.headers?.["idempotency-key"]||randomUUID());
   if(!/^[a-zA-Z0-9_.:-]{8,128}$/.test(key))throw bad("Invalid idempotency key");
   const result=await proposeV2Intent(actorId,proposal,key);
   return res.status(result.created?201:200).json({ok:true,...result,nextAction:"human_MFA_approval_required",mode:"wallet_signed_Celo"});
  }
  if(op==="intent"&&req.method==="GET"){
   const intent=await getV2Intent(actorId,safeId(req.query?.id));
   if(!intent)return res.status(404).json({error:"Proposal not found"});
   return res.status(200).json({ok:true,intent,unsignedTransaction:intent.status==="approved"?prepareCeloTransfer(intent):null});
  }
  if(op==="approve"&&req.method==="POST"){
   if(!["owner","admin","approver"].includes(auth.actor.role))throw bad("Approver role required",403);
   const id=safeId(req.body?.id);
   const existing=await getV2Intent(actorId,id);
   if(!existing)return res.status(404).json({error:"Proposal not found"});
   if(existing.status!=="proposed"||new Date(existing.expiresAt).getTime()<=Date.now())throw bad("Proposal expired or already approved",409);
   validateTerms(req,existing);
   const intent=await approveV2Intent(actorId,id,"operator:"+auth.actor.id);
   if(!intent)throw bad("Proposal expired or already processed",409);
   return res.status(200).json({ok:true,intent,unsignedTransaction:prepareCeloTransfer(intent),nextAction:"external_wallet_signature_required"});
  }
  if(op==="confirm"&&req.method==="POST"){
   if(!["owner","admin","approver"].includes(auth.actor.role))throw bad("Operator role required",403);
   const id=safeId(req.body?.id),intent=await getV2Intent(actorId,id);
   if(!intent)return res.status(404).json({error:"Proposal not found"});
   if(intent.status==="confirmed")return res.status(200).json({ok:true,idempotent:true,intent,receipt:receiptFromIntent(intent)});
   if(intent.status!=="approved" || Date.now()>=new Date(intent.expiresAt).getTime())throw bad("Approval expired or not approved",409);
   const result=await verifyCeloPayment(intent,req.body?.txHash,intent.approvedAt);
   if(result.pending)return res.status(202).json({ok:false,status:"pending",...result});
   const updated=await recordV2Confirmation(actorId,id,result);
   if(!updated)throw bad("Intent changed state; refresh and retry",409);
   return res.status(200).json({ok:true,intent:updated,receipt:receiptFromIntent(updated),verification:result});
  }
  if(op==="receipt"&&req.method==="GET"){
   const intent=await getV2Intent(actorId,safeId(req.query?.id));
   if(!intent)return res.status(404).json({error:"Proposal not found"});
   return res.status(200).json({ok:true,receipt:receiptFromIntent(intent)});
  }
  return res.status(405).json({error:"Unsupported operator payment action"});
 }catch(e){
  const status=e.status||(/not configured|required|DATABASE_URL/i.test(String(e.message))?503:400);
  return res.status(status).json({ok:false,error:status===503?"Celo operation is unavailable":String(e.message||"Payment failed").slice(0,160)});
 }
}
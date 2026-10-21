import {createHash} from "node:crypto";
import {requireAgent} from "./agent-v2-auth.js";
import {normalizeCeloProposal,prepareCeloTransfer,verifyCeloPayment,CELO_NETWORK} from "./celo-v2.js";
import {proposeV2Intent,getV2Intent,recordV2Confirmation} from "./agent-v2-store.js";
export const PAYMENT_TOOLS=[
 {name:"celo_payment_propose",description:"Create a Celo wallet-signed payment intent requiring a separate human approval. Cannot move funds.",inputSchema:{type:"object",properties:{token:{type:"string",enum:["USDC","USDT","USDm"]},amount:{type:"string"},payer:{type:"string"},recipient:{type:"string"},memo:{type:"string"},idempotencyKey:{type:"string"}},required:["token","amount","payer","recipient","idempotencyKey"],additionalProperties:false}},
 {name:"celo_payment_get",description:"Retrieve an existing payment intent and approved wallet transaction calldata.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}},
 {name:"celo_payment_confirm",description:"Verify externally signed Celo Mainnet transaction against previously approved terms.",inputSchema:{type:"object",properties:{id:{type:"string"},txHash:{type:"string"}},required:["id","txHash"],additionalProperties:false}},
 {name:"celo_receipt_get",description:"Return an independently verifiable payment receipt only after onchain confirmation.",inputSchema:{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false}}
];
function uuid(id){const val=String(id||"");if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(val))throw Object.assign(new Error("Invalid payment intent ID"),{status:400});return val;}
function safeKey(x){const v=String(x||"");if(!/^[a-zA-Z0-9_.:-]{8,128}$/.test(v))throw Object.assign(new Error("Valid idempotencyKey (8-128 characters) required"),{status:400});return v;}
export function receiptFromIntent(intent){
 if(!intent||intent.status!=="confirmed"||!intent.txHash||!intent.verification)throw Object.assign(new Error("Verified settlement receipt unavailable"),{status:409});
 const verification=intent.verification;
 return {schema:"https://33jack-v2.vercel.app/schemas/receipt-v1",receiptId:"jack_"+createHash("sha256").update(intent.id+":"+intent.txHash).digest("hex"),
  network:"eip155:42220",chainId:CELO_NETWORK.chainId,token:intent.token,tokenAddress:intent.tokenAddress,
  amount:intent.amount,amountUnits:intent.amountUnits,payer:intent.payer,recipient:intent.recipient,
  intentId:intent.id,approvedAt:intent.approvedAt,approvedBy:intent.approvedBy||null,confirmedAt:intent.confirmedAt,
  transactionHash:intent.txHash,logIndex:verification.logIndex,confirmationsAtVerification:verification.confirmations,
  blockExplorer:"https://celoscan.io/tx/"+intent.txHash,
  claim:"Onchain transaction confirmed and matched to approved payment instructions; independently verify current chain finality."};
}
export async function runAgentPaymentTool(req,tool,args={}){
 const agent=requireAgent(req);if(agent.error)throw Object.assign(new Error(agent.error),{status:agent.status});
 if(!args||typeof args!=="object"||Array.isArray(args))throw Object.assign(new Error("Tool arguments must be an object"),{status:400});
 if(tool==="celo_payment_propose"){
  const proposal=normalizeCeloProposal(args);
  if(!proposal.payer)throw Object.assign(new Error("Payer address is mandatory"),{status:400});
  const result=await proposeV2Intent(agent.agentId,proposal,safeKey(args.idempotencyKey));
  return {ok:true,...result,nextAction:"human_MFA_approval_required"};
 }
 if(!PAYMENT_TOOLS.some(t=>t.name===tool))throw Object.assign(new Error("Unsupported financial tool"),{status:404});
 const intent=await getV2Intent(agent.agentId,uuid(args.id));
 if(!intent)throw Object.assign(new Error("Intent not found"),{status:404});
 if(tool==="celo_payment_get")return{ok:true,intent,unsignedTransaction:intent.status==="approved"?prepareCeloTransfer(intent):null};
 if(tool==="celo_receipt_get")return{ok:true,receipt:receiptFromIntent(intent)};
 if(tool==="celo_payment_confirm"){
  if(intent.status==="confirmed")return{ok:true,idempotent:true,receipt:receiptFromIntent(intent)};
  if(intent.status!=="approved"||new Date(intent.expiresAt).getTime()<=Date.now())throw Object.assign(new Error("Payment is not approved or expired"),{status:409});
  const result=await verifyCeloPayment(intent,args.txHash,intent.approvedAt);
  if(result.pending)return{ok:false,pending:true,...result};
  const updated=await recordV2Confirmation(agent.agentId,intent.id,result);
  if(!updated)throw Object.assign(new Error("Payment state changed; reload"),{status:409});
  return{ok:true,receipt:receiptFromIntent(updated)};
 }
}

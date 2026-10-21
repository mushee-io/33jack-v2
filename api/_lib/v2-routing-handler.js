import {requireAgent} from "./agent-v2-auth.js";
import {celoRpc,normalizeCeloProposal,prepareCeloTransfer,CELO_TOKENS,CELO_NETWORK} from "./celo-v2.js";
import {getAgentPolicy,evaluateAgentPolicy} from "./agent-policy.js";
function nativePrice(wei){const n=BigInt(wei),base=10n**18n;return (n/base).toString()+"."+String(n%base).padStart(18,"0").slice(0,9);}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="POST")return res.status(405).json({error:"POST with payer, recipient, amount and acceptedTokens required"});
 const actor=requireAgent(req);if(actor.error)return res.status(actor.status).json({error:actor.error});
 const allowed=req.body?.acceptedTokens;
 if(!Array.isArray(allowed)||allowed.length<1||allowed.length>3||!allowed.every(t=>["USDC","USDT","USDm"].includes(t)))return res.status(400).json({error:"Choose one to three supported Celo assets"});
 try{
  const policy=await getAgentPolicy(actor.agentId);
  const chain=await celoRpc("eth_chainId");
  if(BigInt(chain)!==42220n)return res.status(503).json({error:"RPC is not on Celo Mainnet"});
  const gasPrice=BigInt(await celoRpc("eth_gasPrice"));
  const results=[];
  for(const token of [...new Set(allowed)]){
   const payment=normalizeCeloProposal({...req.body,token});
   const verdict=evaluateAgentPolicy(policy?.policy,payment);
   if(!verdict.allowed){results.push({token,eligible:false,reason:verdict.reason});continue;}
   const tx=prepareCeloTransfer(payment);
   try{
    const balanceData="0x70a08231"+payment.payer.slice(2).padStart(64,"0");
    const [balanceHex,gasHex]=await Promise.all([
      celoRpc("eth_call",[{to:CELO_TOKENS[token].address,data:balanceData},"latest"]),
      celoRpc("eth_estimateGas",[{from:payment.payer,to:tx.to,data:tx.data,value:"0x0"}])
    ]);
    const balance=BigInt(balanceHex),gas=BigInt(gasHex);
    results.push({token,eligible:balance>=BigInt(payment.amountUnits),sufficientTokenBalance:balance>=BigInt(payment.amountUnits),
      quotedAmountUnits:payment.amountUnits,estimatedGas:gas.toString(),gasPriceWei:gasPrice.toString(),
      estimatedNetworkFeeNativeCelo:nativePrice(gas*gasPrice),estimatedOnly:true,
      reason:balance<BigInt(payment.amountUnits)?"Insufficient ERC-20 token balance":null});
   }catch{results.push({token,eligible:false,reason:"RPC could not estimate transaction"});}
  }
  const eligible=results.filter(r=>r.eligible).sort((a,b)=>BigInt(a.estimatedGas)*BigInt(a.gasPriceWei)<BigInt(b.estimatedGas)*BigInt(b.gasPriceWei)?-1:1);
  return res.status(200).json({ok:true,network:CELO_NETWORK.name,quotes:results,recommendedToken:eligible[0]?.token||null,
    disclaimer:"Estimates are read from Celo Mainnet RPC, denominated in native CELO for gas. No FX, bridge, fiat payout, or guarantee of future network fees. Signing always requires explicit approval."});
 }catch(e){return res.status(e.status||503).json({error:e.status===400?e.message:"No live Celo route estimate available"});}
}

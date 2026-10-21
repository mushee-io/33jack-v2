import {requireOperator} from "./operator-auth.js";
import {ensureV2Store} from "./agent-v2-store.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 if(req.method!=="GET")return res.status(405).json({error:"GET required"});
 const gate=requireOperator(req,["owner","admin"]);if(gate.error)return res.status(gate.status).json({error:gate.error});
 try{
  const sql=await ensureV2Store();
  const [states,agents,daily,totals,receipts]=await Promise.all([
   sql.unsafe("SELECT status,COUNT(*)::int AS count FROM jack_v2_intents GROUP BY status"),
   sql.unsafe("SELECT agent_id,COUNT(*)::int AS proposals,COUNT(*) FILTER(WHERE status='confirmed')::int AS confirmed FROM jack_v2_intents WHERE created_at>=NOW()-INTERVAL '30 days' GROUP BY agent_id ORDER BY proposals DESC LIMIT 50"),
   sql.unsafe("SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day,COUNT(*)::int AS proposals,COUNT(*) FILTER(WHERE status='confirmed')::int AS confirmed FROM jack_v2_intents WHERE created_at>=NOW()-INTERVAL '30 days' GROUP BY day ORDER BY day"),
   sql.unsafe("SELECT token,decimals,SUM(amount_units::numeric)::text AS settled_units,COUNT(*)::int AS count FROM jack_v2_intents WHERE status='confirmed' GROUP BY token,decimals ORDER BY token"),
   sql.unsafe("SELECT id,tx_hash,token,amount,confirmed_at FROM jack_v2_intents WHERE status='confirmed' ORDER BY confirmed_at DESC LIMIT 25")
  ]);
  const all=Object.fromEntries(states.map(x=>[x.status,x.count]));
  const confirmed=all.confirmed||0,total=Object.values(all).reduce((a,b)=>a+b,0);
  return res.status(200).json({ok:true,asOf:new Date().toISOString(),source:"jack_v2_intents_database",network:"Celo Mainnet",
   metrics:{allTimeProposals:total,allTimeConfirmed:confirmed,confirmationRate:total?Number((100*confirmed/total).toFixed(2)):0,uniqueAgents30d:agents.length,
    pendingApproval:all.proposed||0,approvedAwaitingSettlement:all.approved||0},
   statuses:states,agentActivity:agents,daily30d:daily,confirmedAmountsByToken:totals,
   recentVerifiedSettlements:receipts.map(x=>({intentId:x.id,token:x.token,amount:x.amount,confirmedAt:x.confirmed_at,transactionHash:x.tx_hash,explorer:"https://celoscan.io/tx/"+x.tx_hash})),
   verifiedOnly:true,analyticsWarning:"Counts are based on persisted 33JACK V2 intents. Not independent audit, unique wallets, or a guarantee of customer adoption."});
 }catch{return res.status(503).json({error:"Database-backed metrics unavailable"});}
}

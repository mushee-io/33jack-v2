import postgres from "postgres";
import {randomUUID,createHash,timingSafeEqual} from "node:crypto";
import {requireOperator} from "./operator-auth.js";
import {normalizeCeloProposal} from "./celo-v2.js";
import {checkAgentPolicy} from "./agent-policy.js";
import {proposeV2Intent} from "./agent-v2-store.js";
let connection,schema;
function db(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("DATABASE_URL not configured"),{status:503});return connection ||= postgres(process.env.DATABASE_URL,{max:2,idle_timeout:20,connect_timeout:8});}
async function ready(){
 if(!schema)schema=db().unsafe("CREATE TABLE IF NOT EXISTS jack_v2_schedules (id UUID PRIMARY KEY,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,payment JSONB NOT NULL,interval_days INT NOT NULL,next_run_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").then(()=>db().unsafe("CREATE TABLE IF NOT EXISTS jack_v2_schedule_runs (id UUID PRIMARY KEY,schedule_id UUID NOT NULL REFERENCES jack_v2_schedules(id),cycle_at TIMESTAMPTZ NOT NULL,status TEXT NOT NULL DEFAULT 'pending_review',intent_id UUID,reviewed_by TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(schedule_id,cycle_at))")).catch(e=>{schema=null;throw e});
 await schema;return db();
}
function space(actor){const id=String(process.env.JACK_SCHEDULE_WORKSPACE_ID||"");if(!id)throw Object.assign(new Error("JACK_SCHEDULE_WORKSPACE_ID not configured"),{status:503});if(actor.workspaceId&&actor.workspaceId!==id)throw Object.assign(new Error("Workspace access denied"),{status:403});return id;}
function matchSecret(a,b){const x=createHash("sha256").update(String(a||"")).digest(),y=createHash("sha256").update(String(b||"")).digest();return timingSafeEqual(x,y);}
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 const operation=String(req.query?.operation||"list");
 try{
  if(operation==="runDue"&&req.method==="GET"){
   const secret=String(process.env.CRON_SECRET||"");
   if(secret.length<32||!matchSecret(req.headers?.authorization,"Bearer "+secret))return res.status(401).json({error:"CRON_SECRET authorization required"});
   const sql=await ready();
   const runs=await sql.begin(async tx=>{
    const due=await tx.unsafe("SELECT * FROM jack_v2_schedules WHERE status='active' AND next_run_at<=NOW() ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED");
    const made=[];
    for(const schedule of due){
      const id=randomUUID();
      const inserted=await tx.unsafe("INSERT INTO jack_v2_schedule_runs(id,schedule_id,cycle_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",[id,schedule.id,schedule.next_run_at]);
      if(inserted.length)made.push({id,scheduleId:schedule.id});
      await tx.unsafe("UPDATE jack_v2_schedules SET next_run_at=GREATEST(next_run_at+($2::int*INTERVAL '1 day'),NOW()+INTERVAL '1 day') WHERE id=$1",[schedule.id,schedule.interval_days]);
    }
    return made;
   });
   return res.status(200).json({ok:true,created:runs.length,pendingReview:runs,automaticPayments:0});
  }
  const gate=requireOperator(req,["owner","admin","approver"]);if(gate.error)return res.status(gate.status).json({error:gate.error});
  const workspaceId=space(gate.actor),sql=await ready();
  if(operation==="list"&&req.method==="GET"){
   const schedules=await sql.unsafe("SELECT id,agent_id,payment,interval_days,next_run_at,status,created_by,created_at FROM jack_v2_schedules WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100",[workspaceId]);
   const runs=await sql.unsafe("SELECT r.id,r.schedule_id,r.status,r.cycle_at,r.intent_id,r.reviewed_by FROM jack_v2_schedule_runs r JOIN jack_v2_schedules s ON s.id=r.schedule_id WHERE s.workspace_id=$1 ORDER BY r.created_at DESC LIMIT 100",[workspaceId]);
   return res.status(200).json({ok:true,schedules,runs,execution:"manual_MFA_approval_and_wallet_signature"});
  }
  if(operation==="create"&&req.method==="POST"){
   if(!["owner","admin"].includes(gate.actor.role))return res.status(403).json({error:"Owner or admin required"});
   const agentId=String(req.body?.agentId||""),intervalDays=Number(req.body?.intervalDays);
   if(!/^[a-z0-9_-]{2,64}$/i.test(agentId)||agentId.startsWith("channel_")||!Number.isInteger(intervalDays)||intervalDays<1||intervalDays>90)return res.status(400).json({error:"Invalid agent or schedule frequency"});
   const when=new Date(req.body?.firstRunAt||"");
   if(!Number.isFinite(when.getTime())||when.getTime()<Date.now()+60000||when.getTime()>Date.now()+366*86400000)return res.status(400).json({error:"Invalid firstRunAt"});
   const proposal=normalizeCeloProposal(req.body?.payment||{});
   if(!proposal.payer)return res.status(400).json({error:"Exact payer wallet required"});
   const policy=await checkAgentPolicy(agentId,proposal);
   if(!policy.allowed)return res.status(403).json({error:"Agent policy denied schedule: "+policy.reason});
   const id=randomUUID();
   await sql.unsafe("INSERT INTO jack_v2_schedules(id,workspace_id,agent_id,payment,interval_days,next_run_at,created_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)",[id,workspaceId,agentId,JSON.stringify(proposal),intervalDays,when.toISOString(),gate.actor.id]);
   return res.status(201).json({ok:true,id,nextRunAt:when.toISOString(),automaticExecution:false});
  }
  if(operation==="cancel"&&req.method==="POST"){
   if(!["owner","admin"].includes(gate.actor.role))return res.status(403).json({error:"Owner or admin required"});
   const rows=await sql.unsafe("UPDATE jack_v2_schedules SET status='cancelled' WHERE id=$1 AND workspace_id=$2 AND status='active' RETURNING id",[req.body?.id,workspaceId]);
   return rows[0]?res.status(200).json({ok:true,id:rows[0].id}):res.status(404).json({error:"Active schedule not found"});
  }
  if(operation==="prepare"&&req.method==="POST"){
   const id=String(req.body?.runId||"");
   if(!/^[a-f0-9-]{36}$/i.test(id))return res.status(400).json({error:"Invalid run ID"});
   const rows=await sql.unsafe("SELECT r.*,s.agent_id,s.payment,s.workspace_id FROM jack_v2_schedule_runs r JOIN jack_v2_schedules s ON s.id=r.schedule_id WHERE r.id=$1 AND s.workspace_id=$2",[id,workspaceId]);
   const item=rows[0];if(!item)return res.status(404).json({error:"Run not found"});
   if(item.status==="proposed")return res.status(200).json({ok:true,idempotent:true,intentId:item.intent_id});
   if(item.status!=="pending_review")return res.status(409).json({error:"Run not eligible"});
   const policy=await checkAgentPolicy(item.agent_id,item.payment);
   if(!policy.allowed)return res.status(403).json({error:"Agent policy denied: "+policy.reason});
   const result=await proposeV2Intent(item.agent_id,item.payment,"scheduled:"+id);
   const changed=await sql.unsafe("UPDATE jack_v2_schedule_runs SET status='proposed',intent_id=$3,reviewed_by=$4 WHERE id=$1 AND status='pending_review' AND schedule_id=$2 RETURNING id",[id,item.schedule_id,result.intent.id,gate.actor.id]);
   return res.status(200).json({ok:true,intent:result.intent,created:result.created,reviewRecorded:changed.length===1,nextAction:"separate_human_MFA_approval"});
  }
  return res.status(405).json({error:"Unknown schedule operation"});
 }catch(e){return res.status(e.status||503).json({error:e.status===400||e.status===403?e.message:"Schedule subsystem unavailable"});}
}

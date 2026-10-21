import postgres from "postgres";
import { randomUUID, createHash } from "node:crypto";
import {ensureAgentPolicyStore,evaluateAgentPolicy} from "./agent-policy.js";

let client;
let initialized;
function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for Celo V2; in-memory settlement is disabled");
  if (!client) client = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 8 });
  return client;
}
export async function ensureV2Store() {
  if (!initialized) {
    initialized = db().unsafe(
      "CREATE TABLE IF NOT EXISTS jack_v2_intents (" +
      "id UUID PRIMARY KEY, agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, " +
      "chain_id INTEGER NOT NULL, token TEXT NOT NULL, token_address TEXT NOT NULL, decimals INTEGER NOT NULL, " +
      "amount TEXT NOT NULL, amount_units TEXT NOT NULL, recipient TEXT NOT NULL, payer TEXT, memo TEXT NOT NULL DEFAULT '', " +
      "status TEXT NOT NULL DEFAULT 'proposed', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
      "expires_at TIMESTAMPTZ NOT NULL, approved_at TIMESTAMPTZ, approved_by TEXT, " +
      "tx_hash TEXT UNIQUE, confirmed_at TIMESTAMPTZ, verification JSONB, source_context JSONB, " +
      "UNIQUE(agent_id, idempotency_key))"
    ).then(async () => {
      await db().unsafe("ALTER TABLE jack_v2_intents ADD COLUMN IF NOT EXISTS source_context JSONB");
    }).catch((error) => { initialized = null; throw error; });
  }
  await initialized;
  return db();
}
function publicIntent(row) {
  if (!row) return null;
  return {
    id: row.id, agentId: row.agent_id, chainId: row.chain_id,
    token: row.token, tokenAddress: row.token_address, decimals: row.decimals,
    amount: row.amount, amountUnits: row.amount_units, recipient: row.recipient,
    payer: row.payer, memo: row.memo, status: row.status,
    createdAt: row.created_at, expiresAt: row.expires_at,
    approvedAt: row.approved_at, approvedBy: row.approved_by, confirmedAt: row.confirmed_at,
    txHash: row.tx_hash, verification: row.verification,
    sourceContext: row.source_context || null
  };
}

export async function proposeV2Intent(agentId, proposal, key) {
  const sql = await ensureV2Store();
  const fingerprint = createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  const id = randomUUID();
  const rows = await sql.unsafe(
    "INSERT INTO jack_v2_intents (id,agent_id,idempotency_key,fingerprint,chain_id,token,token_address,decimals,amount,amount_units,recipient,payer,memo,expires_at,source_context) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW() + INTERVAL '30 minutes',$14::jsonb) " +
    "ON CONFLICT(agent_id,idempotency_key) DO NOTHING RETURNING *",
    [id, agentId, key, fingerprint, proposal.chainId, proposal.token, proposal.tokenAddress, proposal.decimals,
      proposal.amount, proposal.amountUnits, proposal.recipient, proposal.payer, proposal.memo,
      proposal.sourceContext ? JSON.stringify(proposal.sourceContext) : null]
  );
  if (rows[0]) return { intent: publicIntent(rows[0]), created: true };
  const existing = await sql.unsafe(
    "SELECT * FROM jack_v2_intents WHERE agent_id=$1 AND idempotency_key=$2", [agentId, key]
  );
  if (existing[0]?.fingerprint !== fingerprint) {
    const error = new Error("Idempotency key is already bound to a different payment"); error.status = 409; throw error;
  }
  return { intent: publicIntent(existing[0]), created: false };
}

export async function getV2Intent(agentId, id) {
  const sql = await ensureV2Store();
  const rows = await sql.unsafe("SELECT * FROM jack_v2_intents WHERE id=$1 AND agent_id=$2", [id, agentId]);
  return publicIntent(rows[0]);
}

export async function approveV2Intent(agentId, id, approvedBy = "legacy-api-key") {
 const sql=await ensureV2Store();
 // Channel invoice intents have separate workspace authorisation and per-invoice limits.
 if(String(agentId).startsWith("channel_")){
  const rows=await sql.unsafe("UPDATE jack_v2_intents SET status='approved',approved_at=NOW(),approved_by=$3 WHERE id=$1 AND agent_id=$2 AND status='proposed' AND expires_at>NOW() RETURNING *",[id,agentId,approvedBy]);
  return publicIntent(rows[0]);
 }
 await ensureAgentPolicyStore();
 return sql.begin(async trx=>{
  await trx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))",[agentId]);
  const rows=await trx.unsafe("SELECT * FROM jack_v2_intents WHERE id=$1 AND agent_id=$2 AND status='proposed' AND expires_at>NOW() FOR UPDATE",[id,agentId]);
  if(!rows[0])return null;
  const policy=await trx.unsafe("SELECT policy FROM jack_v2_agent_policies WHERE agent_id=$1",[agentId]);
  const today=await trx.unsafe("SELECT amount_units,decimals FROM jack_v2_intents WHERE agent_id=$1 AND status IN ('approved','confirmed') AND approved_at>=date_trunc('day',NOW())",[agentId]);
  const verdict=evaluateAgentPolicy(policy[0]?.policy,rows[0],today);
  if(!verdict.allowed)throw Object.assign(new Error("Spending policy denied at approval: "+verdict.reason),{status:403});
  const updated=await trx.unsafe("UPDATE jack_v2_intents SET status='approved',approved_at=NOW(),approved_by=$3 WHERE id=$1 AND agent_id=$2 AND status='proposed' AND expires_at>NOW() RETURNING *",[id,agentId,approvedBy]);
  return publicIntent(updated[0]);
 });
}

export async function recordV2Confirmation(agentId, id, result) {
  const sql = await ensureV2Store();
  let rows;
  try {
    rows = await sql.unsafe(
      "UPDATE jack_v2_intents SET status='confirmed', tx_hash=$3, confirmed_at=NOW(), verification=$4::jsonb " +
      "WHERE id=$1 AND agent_id=$2 AND status='approved' AND expires_at>NOW() RETURNING *",
      [id, agentId, result.txHash, JSON.stringify(result)]
    );
  } catch (error) {
    if (error.code === "23505") {
      const conflict = new Error("This transaction was already assigned to another payment");
      conflict.status = 409; throw conflict;
    }
    throw error;
  }
  return publicIntent(rows[0]);
}

export async function getV2IntentForInvoice(agentId, idempotencyKey) {
  const sql = await ensureV2Store();
  const rows = await sql.unsafe(
    "SELECT * FROM jack_v2_intents WHERE agent_id=$1 AND idempotency_key=$2 LIMIT 1",
    [agentId, idempotencyKey]
  );
  return publicIntent(rows[0]);
}

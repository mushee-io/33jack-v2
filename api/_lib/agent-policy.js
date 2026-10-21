import postgres from "postgres";
let client,initialized;
function db(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("DATABASE_URL required"),{status:503});return client ||= postgres(process.env.DATABASE_URL,{max:2,idle_timeout:20,connect_timeout:8});}
export async function ensureAgentPolicyStore(){if(!initialized)initialized=db().unsafe("CREATE TABLE IF NOT EXISTS jack_v2_agent_policies (agent_id TEXT PRIMARY KEY, policy JSONB NOT NULL, updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").catch(e=>{initialized=null;throw e});await initialized;return db();}
const ADDR=/^0x[0-9a-fA-F]{40}$/;
export function amountE18(value){
 const s=String(value??"");if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,18})?$/.test(s))throw Object.assign(new Error("Invalid policy amount"),{status:400});
 const [whole,decimal=""]=s.split(".");return BigInt(whole)*10n**18n+BigInt(decimal.padEnd(18,"0")||"0");
}
export function normalizeAgentPolicy(raw={}){
 if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Object.assign(new Error("Policy object required"),{status:400});
 const strings=(key)=>{const a=raw[key];if(!Array.isArray(a)||a.length<1||a.length>100)throw Object.assign(new Error(key+" must be a non-empty array"),{status:400});return [...new Set(a.map(s=>String(s).trim().toLowerCase()))];};
 const recipients=strings("recipients"),payers=strings("payers");
 if(!recipients.every(x=>ADDR.test(x)&&!/^0x0{40}$/.test(x))||!payers.every(x=>ADDR.test(x)&&!/^0x0{40}$/.test(x)))throw Object.assign(new Error("Invalid allowlisted wallet address"),{status:400});
 const tokens=strings("tokens").map(x=>x==="cusd"?"USDm":x==="usdm"?"USDm":x.toUpperCase());
 if(!tokens.every(x=>["USDC","USDT","USDm"].includes(x)))throw Object.assign(new Error("Unsupported policy token"),{status:400});
 const per=amountE18(raw.maxPerPayment),daily=amountE18(raw.maxPerDay);
 if(per<1n||daily<per)throw Object.assign(new Error("Daily allowance must cover per-payment allowance"),{status:400});
 if(raw.enabled!==true&&raw.enabled!==false)throw Object.assign(new Error("Set policy.enabled explicitly"),{status:400});
 if(raw.authorization!=="human-and-wallet")throw Object.assign(new Error("Only human-and-wallet approval is supported"),{status:400});
 return{enabled:raw.enabled,authorization:"human-and-wallet",tokens:[...new Set(tokens)],recipients,payers,
  maxPerPayment:String(raw.maxPerPayment),maxPerDay:String(raw.maxPerDay),version:1};
}
export function evaluateAgentPolicy(raw,proposal,prior=[]){
 if(!raw||raw.enabled!==true)return{allowed:false,reason:"Agent has no active spending policy"};
 try{
  const policy=normalizeAgentPolicy(raw);
  if(!policy.tokens.includes(proposal.token))return{allowed:false,reason:"Token is outside agent allowlist"};
  if(!policy.recipients.includes(String(proposal.recipient||"").toLowerCase()))return{allowed:false,reason:"Recipient is not allowlisted"};
  if(!policy.payers.includes(String(proposal.payer||"").toLowerCase()))return{allowed:false,reason:"Payer wallet is not allowlisted"};
  const amount=BigInt(proposal.amountUnits??proposal.amount_units)*(10n**BigInt(18-Number(proposal.decimals)));
  if(amount>amountE18(policy.maxPerPayment))return{allowed:false,reason:"Per-payment policy ceiling exceeded"};
  let committed=0n;
  for(const old of prior){const dec=Number(old.decimals);if(dec<0||dec>18)throw Error("Invalid stored token decimals");committed+=BigInt(old.amount_units)*(10n**BigInt(18-dec));}
  if(committed+amount>amountE18(policy.maxPerDay))return{allowed:false,reason:"Agent daily allowance exceeded"};
  return{allowed:true,authorization:"human-and-wallet",dailyRemainingBefore:((amountE18(policy.maxPerDay)-committed)/10n**12n).toString()+" microUSD"};
 }catch(e){return{allowed:false,reason:"Invalid agent policy: "+e.message};}
}
export async function getAgentPolicy(agentId){const sql=await ensureAgentPolicyStore();const rows=await sql.unsafe("SELECT policy,updated_by,updated_at FROM jack_v2_agent_policies WHERE agent_id=$1",[agentId]);return rows[0]||null;}
export async function setAgentPolicy(agentId,raw,actorId){
 if(!/^[a-z0-9_-]{2,64}$/i.test(String(agentId||""))||/^(?:channel_|operator_)/i.test(String(agentId)))throw Object.assign(new Error("Invalid external agent ID"),{status:400});
 const policy=normalizeAgentPolicy(raw),sql=await ensureAgentPolicyStore();
 await sql.unsafe("INSERT INTO jack_v2_agent_policies(agent_id,policy,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(agent_id) DO UPDATE SET policy=excluded.policy,updated_by=excluded.updated_by,updated_at=NOW()",[agentId,JSON.stringify(policy),actorId]);
 return policy;
}
export async function checkAgentPolicy(agentId,proposal){
 const policy=await getAgentPolicy(agentId);return evaluateAgentPolicy(policy?.policy,proposal);
}

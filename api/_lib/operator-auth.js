import {createHmac,randomBytes,scryptSync,timingSafeEqual,createCipheriv,createDecipheriv,hkdfSync} from "node:crypto";
import postgres from "postgres";
let client,started;
function db(){if(!process.env.DATABASE_URL)throw Object.assign(new Error("DATABASE_URL required"),{status:503});return client ||= postgres(process.env.DATABASE_URL,{max:2,idle_timeout:20,connect_timeout:8});}
async function store(){if(!started)started=db().unsafe("CREATE TABLE IF NOT EXISTS jack_login_limits (id TEXT PRIMARY KEY, attempts INT NOT NULL DEFAULT 0, window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(), blocked_until TIMESTAMPTZ)").catch(e=>{started=null;throw e});await started;return db();}
function equals(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);}
function key(){const s=String(process.env.JACK_SESSION_SECRET||"");if(s.length<48)throw Object.assign(new Error("JACK_SESSION_SECRET is required"),{status:503});return s;}
function users(){try{const o=JSON.parse(process.env.JACK_OPERATORS_JSON||"{}");return o&&typeof o==="object"&&!Array.isArray(o)?o:{};}catch{return {};}}
function base32(input){const abc="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",s=String(input||"").toUpperCase().replace(/=+$/,"");if(!s||/[^A-Z2-7]/.test(s))return null;let n=0,bits=0,arr=[];for(const c of s){n=(n<<5)|abc.indexOf(c);bits+=5;if(bits>=8){bits-=8;arr.push((n>>bits)&255);}}return Buffer.from(arr);}
export function verifyTotp(seed,value,now=Date.now()){const k=base32(seed);if(!k||k.length<10||!/^\d{6}$/.test(String(value||"")))return false;const count=Math.floor(now/30000);for(const x of [-1,0,1]){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(count+x));const d=createHmac("sha1",k).update(b).digest(),offset=d[19]&15;const expected=String((d.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,"0");if(equals(expected,value))return true;}return false;}
export function signSession(identity,now=Date.now()){const payload=Buffer.from(JSON.stringify({sub:identity.id,role:identity.role,workspaceId:identity.workspaceId||null,exp:now+900000,nonce:randomBytes(12).toString("hex")})).toString("base64url");return payload+"."+createHmac("sha256",key()).update(payload).digest("base64url");}
export function getSession(req){let secret;try{secret=key();}catch{return null;}const cookie=String(req.headers?.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("__Host-jack_session="));if(!cookie)return null;const [payload,signature,...extra]=cookie.split("=")[1].split(".");if(!payload||!signature||extra.length)return null;if(!equals(signature,createHmac("sha256",secret).update(payload).digest("base64url")))return null;let o;try{o=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));}catch{return null;}if(!o||!Number.isSafeInteger(o.exp)||o.exp<Date.now()||o.exp>Date.now()+900000)return null;if(!/^[a-z0-9_-]{2,64}$/i.test(String(o.sub||""))||!["owner","admin","approver","viewer"].includes(o.role))return null;if(process.env.JACK_OPERATOR_DB_AUTH!=="true"){const live=users()[o.sub];if(!live||live.role!==o.role||String(live.workspaceId||"")!==String(o.workspaceId||""))return null;}return{id:o.sub,role:o.role,workspaceId:o.workspaceId||null};}
export function setSession(res,actor){res.setHeader("Set-Cookie","__Host-jack_session="+signSession(actor)+"; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=900");}
export function clearSession(res){res.setHeader("Set-Cookie","__Host-jack_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");}
export function sameOrigin(req){const origin=req.headers?.origin;if(!origin)return true;try{const url=new URL(origin);return url.protocol==="https:"&&url.host===String(req.headers?.["x-forwarded-host"]||req.headers?.host||"");}catch{return false;}}
export function requireOperator(req,roles=["owner","admin","approver"]){const actor=getSession(req);if(!actor)return{status:401,error:"Operator login and authenticator required"};if(!roles.includes(actor.role))return{status:403,error:"Insufficient operator role"};if(["POST","PUT","PATCH","DELETE"].includes(req.method)&&!sameOrigin(req))return{status:403,error:"Origin rejected"};return{actor};}
export function requireLegacyAccess(req){if(process.env.NODE_ENV==="test"&&!process.env.VERCEL&&process.env.JACK_LEGACY_TEST_ACCESS==="enabled")return{actor:{id:"ci-only",role:"owner"}};if(process.env.JACK_ADMIN_SCOPE!=="global")return{status:503,error:"Unscoped legacy finance API disabled until secure workspace migration"};return requireOperator(req,["owner","admin"]);}
export async function login(req,body){const id=String(body.operatorId||"");if(!/^[a-z0-9_-]{2,64}$/i.test(id))return{status:401,error:"Invalid credentials"};const hashId=createHmac("sha256",key()).update(id+":"+String(req.headers?.["x-forwarded-for"]||"").slice(0,80)).digest("hex");const sql=await store(),limit=await sql.unsafe("SELECT blocked_until FROM jack_login_limits WHERE id=$1",[hashId]);if(limit[0]?.blocked_until&&new Date(limit[0].blocked_until)>new Date())return{status:429,error:"Too many attempts"};const u=process.env.JACK_OPERATOR_DB_AUTH==="true"?await databaseOperator(id):users()[id];let valid=false;if(u&&/^[0-9a-f]{32,128}$/i.test(String(u.passwordSalt||""))&&/^[0-9a-f]{128}$/i.test(String(u.passwordHash||""))){const h=String(body.password||"").length<=128?scryptSync(String(body.password||""),Buffer.from(u.passwordSalt,"hex"),64).toString("hex"):"";valid=equals(h,u.passwordHash)&&verifyTotp(u.totpSecret,body.totp)&&["owner","admin","approver","viewer"].includes(u.role);}if(valid){await sql.unsafe("DELETE FROM jack_login_limits WHERE id=$1",[hashId]);return{actor:{id,role:u.role,workspaceId:u.workspaceId||null}};}await sql.unsafe("INSERT INTO jack_login_limits(id,attempts) VALUES($1,1) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN jack_login_limits.window_start<NOW()-INTERVAL '15 minutes' THEN 1 ELSE jack_login_limits.attempts+1 END,window_start=CASE WHEN jack_login_limits.window_start<NOW()-INTERVAL '15 minutes' THEN NOW() ELSE jack_login_limits.window_start END,blocked_until=CASE WHEN jack_login_limits.attempts>=4 AND jack_login_limits.window_start>=NOW()-INTERVAL '15 minutes' THEN NOW()+INTERVAL '30 minutes' ELSE NULL END",[hashId]);return{status:401,error:"Invalid credentials"};}


// Database-authenticated operators and one-time bootstrap. No owner credentials are
// embedded in GitHub or revealed by the server after MFA enrolment.
let operatorsSchema;
async function operatorStore() {
  if(!operatorsSchema) operatorsSchema=db().unsafe(
    "CREATE TABLE IF NOT EXISTS jack_v2_operators ("+
    "id TEXT PRIMARY KEY,role TEXT NOT NULL,workspace_id TEXT NOT NULL,password_salt TEXT NOT NULL,"+
    "password_hash TEXT NOT NULL,totp_ciphertext TEXT NOT NULL,verified_at TIMESTAMPTZ,"+
    "enabled BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
  ).catch(e=>{operatorsSchema=null;throw e});
  await operatorsSchema;return db();
}
function encryptionKey(){return Buffer.from(hkdfSync("sha256",Buffer.from(key()),Buffer.from("33jack-v2-operator"),Buffer.from("totp-encryption-v1"),32));}
function encryptSeed(seed){
 const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",encryptionKey(),iv);
 const data=Buffer.concat([cipher.update(seed,"utf8"),cipher.final()]);
 return [iv.toString("base64url"),data.toString("base64url"),cipher.getAuthTag().toString("base64url")].join(".");
}
function decryptSeed(encoded){
 const parts=String(encoded||"").split(".");
 if(parts.length!==3)throw Error("Encrypted TOTP seed invalid");
 const decipher=createDecipheriv("aes-256-gcm",encryptionKey(),Buffer.from(parts[0],"base64url"));
 decipher.setAuthTag(Buffer.from(parts[2],"base64url"));
 return Buffer.concat([decipher.update(Buffer.from(parts[1],"base64url")),decipher.final()]).toString("utf8");
}
async function databaseOperator(id){
 const sql=await operatorStore();
 const rows=await sql.unsafe("SELECT id,role,workspace_id,password_salt,password_hash,totp_ciphertext FROM jack_v2_operators WHERE id=$1 AND enabled=true AND verified_at IS NOT NULL",[id]);
 const row=rows[0];if(!row)return null;
 return {role:row.role,workspaceId:row.workspace_id,passwordSalt:row.password_salt,passwordHash:row.password_hash,totpSecret:decryptSeed(row.totp_ciphertext)};
}
function validateBootstrap(req,token){
 const configured=String(process.env.JACK_BOOTSTRAP_SECRET||"");
 return configured.length>=48&&String(token||"").length>=48&&
 equals(createHmac("sha256",key()).update(String(token)).digest("hex"),createHmac("sha256",key()).update(configured).digest("hex"))&&sameOrigin(req);
}
function freshTotpSeed(){
 const abc="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",raw=randomBytes(20);let acc=0,bits=0,out="";
 for(const byte of raw){acc=(acc<<8)|byte;bits+=8;while(bits>=5){bits-=5;out+=abc[(acc>>bits)&31];}}
 return out;
}
function bootstrapWorkspace(){
 const id=String(process.env.JACK_PRIMARY_WORKSPACE_ID||"");
 if(!/^[a-z0-9_-]{4,64}$/i.test(id))throw Object.assign(new Error("Primary workspace not configured"),{status:503});
 return id;
}
export async function bootstrapOperator(req,body={},step="start"){
 if(process.env.JACK_OPERATOR_DB_AUTH!=="true")return {status:503,error:"Operator database enrolment disabled"};
 if(!validateBootstrap(req,body.bootstrapSecret))return {status:403,error:"Bootstrap credential invalid"};
 const sql=await operatorStore();
 const operatorId=String(body.operatorId||"").trim();
 if(!/^[a-z0-9_-]{2,64}$/i.test(operatorId))return {status:400,error:"Valid operator ID required"};
 if(step==="start"){
  const password=String(body.password||"");
  if(password.length<16||password.length>128)return {status:400,error:"Choose a unique password between 16 and 128 characters"};
  const passwordSalt=randomBytes(24).toString("hex"),passwordHash=scryptSync(password,Buffer.from(passwordSalt,"hex"),64).toString("hex"),totpSecret=freshTotpSeed();
  const workspaceId=bootstrapWorkspace();
  const started=await sql.begin(async trx=>{
   await trx.unsafe("SELECT pg_advisory_xact_lock(hashtext('jack-v2-bootstrap-owner'))");
   const existing=await trx.unsafe("SELECT id FROM jack_v2_operators WHERE enabled=true LIMIT 1");
   if(existing.length)return false;
   // An unfinished enrolment can be securely replaced with the bootstrap credential.
   await trx.unsafe("DELETE FROM jack_v2_operators WHERE enabled=false AND verified_at IS NULL");
   await trx.unsafe("INSERT INTO jack_v2_operators(id,role,workspace_id,password_salt,password_hash,totp_ciphertext) VALUES($1,'owner',$2,$3,$4,$5)",
    [operatorId,workspaceId,passwordSalt,passwordHash,encryptSeed(totpSecret)]);
   return true;
  });
  if(!started)return {status:409,error:"An operator has already been enrolled"};
  const label=encodeURIComponent("33JACK V2:"+operatorId);
  return {status:200,step:"verify_totp",operatorId,totpSeed:totpSecret,
   otpAuthUri:"otpauth://totp/"+label+"?secret="+totpSecret+"&issuer=33JACK%20V2&digits=6&period=30"};
 }
 if(step==="finish"){
  const actor=await sql.begin(async trx=>{
   await trx.unsafe("SELECT pg_advisory_xact_lock(hashtext('jack-v2-bootstrap-owner'))");
   const enabled=await trx.unsafe("SELECT id FROM jack_v2_operators WHERE enabled=true LIMIT 1");
   if(enabled.length)return null;
   const rows=await trx.unsafe("SELECT * FROM jack_v2_operators WHERE id=$1 AND enabled=false FOR UPDATE",[operatorId]);
   const row=rows[0];if(!row||!verifyTotp(decryptSeed(row.totp_ciphertext),body.totp))return null;
   await trx.unsafe("UPDATE jack_v2_operators SET enabled=true,verified_at=NOW() WHERE id=$1",[operatorId]);
   return {id:operatorId,role:"owner",workspaceId:row.workspace_id};
  });
  if(!actor)return {status:403,error:"TOTP confirmation failed or owner already enrolled"};
  return {status:200,actor};
 }
 return {status:400,error:"Unsupported bootstrap step"};
}
export async function operatorEnrollmentStatus(){
 if(process.env.JACK_OPERATOR_DB_AUTH!=="true")return {configured:false,enrolled:false};
 const sql=await operatorStore();
 const rows=await sql.unsafe("SELECT EXISTS(SELECT 1 FROM jack_v2_operators WHERE enabled=true) AS enrolled");
 return {configured:true,enrolled:Boolean(rows[0].enrolled)};
}

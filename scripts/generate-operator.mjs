import {randomBytes,scryptSync} from "node:crypto";
const id=process.argv[2],password=process.env.JACK_NEW_OPERATOR_PASSWORD;
if(!/^[a-z0-9_-]{2,64}$/i.test(String(id||""))||!password||password.length<16)throw Error("Set JACK_NEW_OPERATOR_PASSWORD (16+ chars), then node scripts/generate-operator.mjs owner-id");
const salt=randomBytes(24).toString("hex"),passwordHash=scryptSync(password,Buffer.from(salt,"hex"),64).toString("hex");
const abc="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",buf=randomBytes(20);let bits=0,acc=0,totpSecret="";
for(const b of buf){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;totpSecret+=abc[(acc>>bits)&31];}}
console.log(JSON.stringify({[id]:{role:"owner",workspaceId:null,passwordSalt:salt,passwordHash,totpSecret}},null,2));
console.error("SECRET: Enter TOTP seed into authenticator and JACK_OPERATORS_JSON into Vercel secrets. Never commit or share this output.");

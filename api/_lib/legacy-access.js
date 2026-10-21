import {requireLegacyAccess} from "./operator-auth.js";
export function gateLegacy(req,res){const gate=requireLegacyAccess(req);if(gate.error){res.setHeader("Cache-Control","no-store");res.status(gate.status).json({error:gate.error});return false;}return true;}

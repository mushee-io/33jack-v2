import {login,requireOperator,setSession,clearSession,bootstrapOperator,operatorEnrollmentStatus,sameOrigin} from "./operator-auth.js";
export default async function handler(req,res){
 res.setHeader("Cache-Control","no-store");
 res.setHeader("X-Content-Type-Options","nosniff");
 const op=String(req.query?.operation||"session");
 if(op==="bootstrap-status"&&req.method==="GET"){
  try {return res.status(200).json({ok:true,...await operatorEnrollmentStatus()});}
  catch{return res.status(503).json({error:"Operator database unavailable"});}
 }
 if(op==="session"&&req.method==="GET"){
  const auth=requireOperator(req,["owner","admin","approver","viewer"]);
  return auth.actor?res.status(200).json({ok:true,actor:auth.actor}):res.status(401).json({ok:false});
 }
 if(req.method==="POST"&&!sameOrigin(req))return res.status(403).json({error:"Origin check failed"});
 if(op==="login"&&req.method==="POST"){
  if(Number(req.headers?.["content-length"]||0)>3000)return res.status(413).json({error:"Too large"});
  try{
   const out=await login(req,req.body||{});
   if(!out.actor)return res.status(out.status).json({error:out.error});
   setSession(res,out.actor);
   return res.status(200).json({ok:true,actor:out.actor});
  }catch{return res.status(503).json({error:"Login currently unavailable"});}
 }
 if((op==="bootstrap-start"||op==="bootstrap-finish")&&req.method==="POST"){
  if(Number(req.headers?.["content-length"]||0)>4000)return res.status(413).json({error:"Too large"});
  try{
   const out=await bootstrapOperator(req,req.body||{},op==="bootstrap-start"?"start":"finish");
   if(out.actor){setSession(res,out.actor);return res.status(200).json({ok:true,actor:out.actor});}
   return res.status(out.status).json({...out,ok:out.status===200});
  }catch(e){return res.status(e.status===400?400:503).json({error:e.status===400?e.message:"Owner enrolment unavailable"});}
 }
 if(op==="logout"&&req.method==="POST"){
  clearSession(res);return res.status(200).json({ok:true});
 }
 return res.status(405).json({error:"Unsupported auth operation"});
}
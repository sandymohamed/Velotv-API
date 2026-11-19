const {randomBytes,randomUUID,createHash}=require('node:crypto');
const bcrypt=require('bcryptjs');
const {transaction}=require('../config/database');
const {HttpError}=require('../utils/errors');
const digest=token=>createHash('sha256').update(token).digest('hex');
function invitationUrl(token,env=process.env){
  const url=new URL(env.RESELLER_DASHBOARD_URL||'http://localhost:5173');
  if(url.username||url.password||(!['https:'].includes(url.protocol)&&!(env.NODE_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new HttpError(503,'Configure a secure reseller dashboard URL.');
  url.hash='setup='+token;return url.href;
}
async function issueInvitation(pool,resellerId,actor,{mailer=null,manual=false}={}){
  if(!['admin','agent'].includes(actor.role))throw new HttpError(403,'Invitation management is not allowed.');
  const token=randomBytes(32).toString('hex');
  const link=invitationUrl(token);
  const invitation=await transaction(pool,async db=>{
    if(actor.role==='agent'){
      const [[agent]]=await db.execute('SELECT id FROM velotv_agents WHERE id=? AND status=1 FOR UPDATE',[actor.id]);
      if(!agent)throw new HttpError(403,'Agent access is disabled.');
    }
    const [[reseller]]=await db.execute('SELECT id,email,agent_id,onboarding_pending,status,archived_at FROM resellers WHERE id=? FOR UPDATE',[resellerId]);
    if(!reseller||(actor.role==='agent'&&reseller.agent_id!==actor.id))throw new HttpError(404,'Reseller not found.');
    if(!reseller.onboarding_pending)throw new HttpError(409,'The reseller has already set up their account.');
    if(reseller.status!==1||reseller.archived_at)throw new HttpError(409,'Reseller access is paused or archived.');
    await db.execute('UPDATE velotv_reseller_invitations SET revoked_at=UTC_TIMESTAMP() WHERE reseller_id=? AND used_at IS NULL AND revoked_at IS NULL',[resellerId]);
    const id=randomUUID();
    await db.execute(`INSERT INTO velotv_reseller_invitations(id,reseller_id,token_hash,expires_at)
      VALUES (?,?,?,UTC_TIMESTAMP()+INTERVAL 24 HOUR)`,[id,resellerId,digest(token)]);
    return {id,email:reseller.email};
  });
  let delivery=manual&&actor.role==='admin'?'manual':'not_configured';
  if(mailer&&!(manual&&actor.role==='admin')){
    try{await mailer({to:invitation.email,link});delivery='sent';}catch{delivery='failed';}
  }
  await pool.execute('UPDATE velotv_reseller_invitations SET delivery_status=? WHERE id=?',[delivery,invitation.id]);
  // No token, password or invitation link is ever returned to an agent.
  return {delivery,...(manual&&actor.role==='admin'?{setup_url:link}:{})};
}
async function claimInvitation(pool,token,password){
  const hash=await bcrypt.hash(password,12),tokenHash=digest(token);
  return transaction(pool,async db=>{
    const [[candidate]]=await db.execute('SELECT reseller_id FROM velotv_reseller_invitations WHERE token_hash=?',[tokenHash]);
    if(!candidate)throw new HttpError(400,'Invitation is invalid or expired.');
    // Match the resend lock order: reseller first, invitation second.
    const [[reseller]]=await db.execute('SELECT id,email,status,onboarding_pending,archived_at FROM resellers WHERE id=? FOR UPDATE',[candidate.reseller_id]);
    const [[invite]]=await db.execute(`SELECT id FROM velotv_reseller_invitations WHERE token_hash=?
      AND used_at IS NULL AND revoked_at IS NULL AND expires_at>UTC_TIMESTAMP() FOR UPDATE`,[tokenHash]);
    if(!invite||!reseller||!reseller.onboarding_pending)throw new HttpError(400,'Invitation is invalid, expired or already used.');
    if(reseller.status!==1||reseller.archived_at)throw new HttpError(403,'Reseller access is disabled.');
    await db.execute('UPDATE resellers SET password=?,onboarding_pending=0,updated_at=UTC_TIMESTAMP() WHERE id=?',[hash,reseller.id]);
    await db.execute('UPDATE velotv_reseller_invitations SET used_at=UTC_TIMESTAMP() WHERE id=?',[invite.id]);
    await db.execute('UPDATE velotv_reseller_invitations SET revoked_at=UTC_TIMESTAMP() WHERE reseller_id=? AND id<>? AND used_at IS NULL',[reseller.id,invite.id]);
    return {success:true,email:reseller.email};
  });
}
module.exports={issueInvitation,claimInvitation,invitationUrl};

const {createHash,randomUUID,randomBytes}=require('node:crypto');
const bcrypt=require('bcryptjs');
const {transaction}=require('../config/database');
const {HttpError}=require('../utils/errors');
const {cents,euro,transferTerms}=require('../utils/agent-money');
const credits=require('../models/credit-model');
const {units,decimal}=require('./credit-service');

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function lockAgent(db,agentId,active=true){
  const [[agent]]=await db.execute('SELECT id,status,margin_bps,default_plan_id FROM velotv_agents WHERE id=? FOR UPDATE',[agentId]);
  if(!agent)throw new HttpError(404,'Agent not found.');
  if(active&&agent.status!==1)throw new HttpError(403,'Agent access is disabled.');
  const [[wallet]]=await db.execute('SELECT amount FROM velotv_agent_wallets WHERE agent_id=? FOR UPDATE',[agentId]);
  if(!wallet)throw new HttpError(409,'Agent wallet needs reconciliation.');
  return {...agent,balance:wallet.amount};
}
async function requireOwnedReseller(db,agentId,resellerId){
  const [[row]]=await db.execute('SELECT id,agent_id FROM resellers WHERE id=? FOR UPDATE',[resellerId]);
  if(!row||row.agent_id!==agentId)throw new HttpError(404,'Reseller not found.');
  return row;
}
async function walletEntry(db,agentId,kind,operationId,oldBalance,newBalance,role,actor){
  const delta=cents(newBalance)-cents(oldBalance);
  await db.execute(`INSERT INTO velotv_agent_wallet_entries
    (agent_id,kind,operation_id,delta,old_balance,new_balance,actor_role,actor_id) VALUES (?,?,?,?,?,?,?,?)`,
  [agentId,kind,operationId,delta<0n?'-'+euro(-delta):euro(delta),oldBalance,newBalance,role,actor]);
  await db.execute('UPDATE velotv_agent_wallets SET amount=?,updated_at=UTC_TIMESTAMP() WHERE agent_id=?',[newBalance,agentId]);
}
function concurrency(error){
  if(['ER_DUP_ENTRY','ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code))throw new HttpError(409,'Concurrent change. Retry with the same reference.');
  throw error;
}
function fundAgent(pool,agentId,adminId,amount,reference){
  const normalized=euro(cents(amount)),ref=reference.toUpperCase();
  if(cents(normalized)<=0n||cents(normalized)>9999999n)throw new HttpError(400,'Invalid funding amount.');
  const fingerprint=hash([agentId,normalized]);
  return transaction(pool,async db=>{
    const agent=await lockAgent(db,agentId,false);
    const [[prior]]=await db.execute('SELECT * FROM velotv_agent_fundings WHERE reference=? FOR UPDATE',[ref]);
    if(prior){if(prior.request_hash!==fingerprint)throw new HttpError(409,'Reference already used with different details.');return prior;}
    const id=randomUUID(),after=euro(cents(agent.balance)+cents(normalized));
    await db.execute(`INSERT INTO velotv_agent_fundings(id,agent_id,admin_id,reference,request_hash,amount,balance_after)
      VALUES (?,?,?,?,?,?,?)`,[id,agentId,adminId,ref,fingerprint,normalized,after]);
    await walletEntry(db,agentId,'funding',id,agent.balance,after,'admin',adminId);
    await db.execute('INSERT INTO velotv_admin_activity(admin_id,action,target_id) VALUES (?,\'agent_funded\',?)',[adminId,agentId]);
    return {id,agent_id:agentId,amount:normalized,balance_after:after,reference:ref,currency:'EUR'};
  }).catch(concurrency);
}
function quoteTransfer(pool,agentId,resellerId,amount){
  return transaction(pool,async db=>{
    const agent=await lockAgent(db,agentId);
    await requireOwnedReseller(db,agentId,resellerId);
    const balance=await credits.lockBalance(db,resellerId,{requireAccess:true});
    const terms=transferTerms(amount,agent.margin_bps);
    if(cents(agent.balance)<cents(terms.cost_amount))throw new HttpError(400,'Agent wallet balance is insufficient.');
    return {...terms,reseller_id:resellerId,agent_balance:agent.balance,
      agent_balance_after:euro(cents(agent.balance)-cents(terms.cost_amount)),
      reseller_balance_after:decimal(units(balance.amount)+units(terms.face_amount))};
  });
}
function transfer(pool,agentId,input,reference){
  const normalized=euro(cents(input.amount));
  const fingerprint=hash([input.reseller_id,normalized,input.expected_cost ?? null,input.expected_margin_bps ?? null]);
  return transaction(pool,async db=>{
    const agent=await lockAgent(db,agentId);
    const [[prior]]=await db.execute('SELECT * FROM velotv_agent_transfers WHERE agent_id=? AND reference=? FOR UPDATE',[agentId,reference]);
    if(prior){if(prior.request_hash!==fingerprint)throw new HttpError(409,'Reference already used with different details.');return prior;}
    await requireOwnedReseller(db,agentId,input.reseller_id);
    const balance=await credits.lockBalance(db,input.reseller_id,{requireAccess:true});
    const terms=transferTerms(normalized,agent.margin_bps);
    if((input.expected_cost!=null&&cents(input.expected_cost)!==cents(terms.cost_amount))||
      (input.expected_margin_bps!=null&&input.expected_margin_bps!==terms.margin_bps))throw new HttpError(409,'Transfer price changed. Request a new quote.');
    if(cents(agent.balance)<cents(terms.cost_amount))throw new HttpError(400,'Agent wallet balance is insufficient.');
    const id=randomUUID(),agentAfter=euro(cents(agent.balance)-cents(terms.cost_amount));
    const resellerAfter=decimal(units(balance.amount)+units(terms.face_amount));
    await db.execute(`INSERT INTO velotv_agent_transfers
      (id,agent_id,reseller_id,reference,request_hash,face_amount,cost_amount,margin_amount,margin_bps,agent_balance_after,reseller_balance_after)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[id,agentId,input.reseller_id,reference,fingerprint,terms.face_amount,terms.cost_amount,
      terms.margin_amount,terms.margin_bps,agentAfter,resellerAfter]);
    await walletEntry(db,agentId,'transfer',id,agent.balance,agentAfter,'agent',agentId);
    // This is internal reseller credit, not another cash receipt by the platform.
    await credits.recordPayment(db,{resellerId:input.reseller_id,reference:'AGENT-'+id,paidAmount:'0.00000',amount:terms.face_amount,kind:'agent'});
    await credits.saveBalance(db,input.reseller_id,balance,decimal(units(balance.amount)),resellerAfter,`Agent funding | Agent ${agentId} | Transfer ${id}`);
    return {id,agent_id:agentId,reseller_id:input.reseller_id,...terms,agent_balance_after:agentAfter,reseller_balance_after:resellerAfter,reference};
  }).catch(concurrency);
}
async function createReseller(pool,agentId,input){
  // The agent never chooses, receives or resets the reseller password.
  const password=await bcrypt.hash(randomBytes(48).toString('base64url'),12);
  return transaction(pool,async db=>{
    await db.execute('SELECT id FROM velotv_staff_creation_lock WHERE id=1 FOR UPDATE');
    const agent=await lockAgent(db,agentId);
    const [[existing]]=await db.execute('SELECT id FROM resellers WHERE email IN (?,?) OR username IN (?,?) LIMIT 1 FOR UPDATE',
      [input.email,input.username,input.email,input.username]);
    if(existing)throw new HttpError(409,'This reseller email or username is already registered.');
    const [[plan]]=await db.execute('SELECT id,duration_months FROM velotv_reseller_plans WHERE id=? AND enabled=1 FOR UPDATE',[agent.default_plan_id]);
    if(!plan)throw new HttpError(409,'Ask the administrator to configure an available default reseller plan.');
    const [created]=await db.execute(`INSERT INTO resellers(username,email,phone,password,agent_id,onboarding_pending)
      VALUES (?,?,?,?,?,1)`,[input.username,input.email,input.phone,password,agentId]);
    await db.execute(`INSERT INTO velotv_reseller_memberships(reseller_id,plan_id,starts_at,expires_at)
      VALUES (?,?,UTC_TIMESTAMP(),TIMESTAMPADD(MONTH,?,UTC_TIMESTAMP()))`,[created.insertId,plan.id,plan.duration_months]);
    return {id:created.insertId,onboarding_pending:true};
  }).catch(concurrency);
}
module.exports={fundAgent,quoteTransfer,transfer,createReseller,lockAgent,requireOwnedReseller};

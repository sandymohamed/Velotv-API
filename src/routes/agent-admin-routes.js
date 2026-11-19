const {Router}=require('express');
const {z}=require('zod');
const bcrypt=require('bcryptjs');
const {authenticate}=require('../middleware/auth');
const {transaction}=require('../config/database');
const {id,reference}=require('../utils/validation');
const {HttpError}=require('../utils/errors');
const {fundAgent}=require('../services/agent-service');
const model=require('../models/agent-model');
const {issueInvitation}=require('../services/reseller-invitation-service');
const {eur}=require('./agent-routes');

const password=z.string().min(10).refine(value=>Buffer.byteLength(value)<=72);
const account=z.object({username:z.string().trim().min(2).max(120),email:z.email().max(255).toLowerCase(),phone:z.string().trim().max(50),
  default_plan_id:id,enabled:z.boolean(),password:password.optional()}).strict();
function agentAdminRoutes(pool,key,mailer=null){
  const router=Router();
  router.use('/api/admin/console',authenticate(pool,key,['admin']));
  router.get('/api/admin/console/agents',async(req,res)=>{
    const page=z.coerce.number().int().min(0).max(10000).default(0).parse(req.query.page);
    const search=z.string().trim().max(120).default('').parse(req.query.search);
    const filter="WHERE (?='' OR LOCATE(LOWER(?),LOWER(CONCAT_WS(' ',a.username,a.email,a.phone)))>0)";
    const [rows]=await pool.execute(`SELECT a.id,a.username,a.email,a.phone,a.status,a.margin_bps,a.default_plan_id,a.created_at,
      w.amount AS balance,(SELECT COUNT(*) FROM resellers r WHERE r.agent_id=a.id) AS reseller_count,
      COALESCE((SELECT SUM(face_amount) FROM velotv_agent_transfers WHERE agent_id=a.id),0) AS sales_total,
      COALESCE((SELECT SUM(margin_amount) FROM velotv_agent_transfers WHERE agent_id=a.id),0) AS margin_total
      FROM velotv_agents a JOIN velotv_agent_wallets w ON w.agent_id=a.id ${filter} ORDER BY a.id DESC LIMIT 50 OFFSET ?`,[search,search,page*50]);
    const [[{count}]]=await pool.execute(`SELECT COUNT(*) AS count FROM velotv_agents a ${filter}`,[search,search]);
    res.json({rows,count});
  });
  async function write(req,res,editing){
    const input=(editing?account:account.extend({password})).parse(req.body);
    const hash=input.password?await bcrypt.hash(input.password,12):null;
    const agentId=editing?id.parse(req.params.id):null;
    const result=await transaction(pool,async db=>{
      await db.execute('SELECT id FROM velotv_staff_creation_lock WHERE id=1 FOR UPDATE');
      if(editing){const [[found]]=await db.execute('SELECT id FROM velotv_agents WHERE id=? FOR UPDATE',[agentId]);if(!found)throw new HttpError(404,'Agent not found.');}
      const [[plan]]=await db.execute('SELECT id FROM velotv_reseller_plans WHERE id=? AND enabled=1',[input.default_plan_id]);
      if(!plan)throw new HttpError(409,'Choose an enabled default reseller plan.');
      const [[duplicate]]=await db.execute('SELECT id FROM velotv_agents WHERE id<>? AND (email IN (?,?) OR username IN (?,?)) LIMIT 1 FOR UPDATE',
        [agentId??0,input.email,input.username,input.email,input.username]);
      if(duplicate)throw new HttpError(409,'This agent email or username is already registered.');
      let created=agentId;
      if(editing){
        await db.execute('UPDATE velotv_agents SET username=?,email=?,phone=?,password=COALESCE(?,password),default_plan_id=?,status=?,updated_at=UTC_TIMESTAMP() WHERE id=?',
          [input.username,input.email,input.phone,hash,input.default_plan_id,input.enabled?1:0,agentId]);
      }else{
        const [row]=await db.execute('INSERT INTO velotv_agents(username,email,phone,password,default_plan_id,status) VALUES (?,?,?,?,?,?)',
          [input.username,input.email,input.phone,hash,input.default_plan_id,input.enabled?1:0]);
        created=row.insertId;await db.execute('INSERT INTO velotv_agent_wallets(agent_id,amount) VALUES (?,0)',[created]);
      }
      await db.execute('INSERT INTO velotv_admin_activity(admin_id,action,target_id) VALUES (?,?,?)',[req.user.id,editing?'agent_updated':'agent_created',created]);
      return created;
    }).catch(error=>{if(error.code==='ER_DUP_ENTRY')throw new HttpError(409,'Agent identity already exists.');throw error;});
    res.status(editing?200:201).json({id:result});
  }
  router.post('/api/admin/console/agents',(req,res)=>write(req,res,false));
  router.patch('/api/admin/console/agents/:id',(req,res)=>write(req,res,true));
  router.post('/api/admin/console/agents/:id/fundings',async(req,res)=>{
    const input=z.object({amount:eur,paymentId:reference}).strict().parse(req.body);
    res.json(await fundAgent(pool,id.parse(req.params.id),req.user.id,input.amount,input.paymentId));
  });
  router.get('/api/admin/console/agents/:id/report',async(req,res)=>{
    const agentId=id.parse(req.params.id);
    const profile=await model.overview(pool,agentId);
    if(!profile)throw new HttpError(404,'Agent not found.');
    const [transfers,wallet]=await Promise.all([model.transfers(pool,agentId),model.entries(pool,agentId)]);
    res.json({profile,transfers,wallet});
  });
  router.post('/api/admin/console/resellers/:id/invitation',async(req,res)=>{
    const {manual}=z.object({manual:z.boolean().default(false)}).strict().parse(req.body??{});
    res.json(await issueInvitation(pool,id.parse(req.params.id),req.user,{mailer,manual}));
  });
  return router;
}
module.exports={agentAdminRoutes};

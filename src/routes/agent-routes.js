const {Router}=require('express');
const {z}=require('zod');
const {rateLimit}=require('express-rate-limit');
const {authenticate}=require('../middleware/auth');
const {login}=require('../controllers/auth-controller');
const {id,reference}=require('../utils/validation');
const service=require('../services/agent-service');
const model=require('../models/agent-model');
const {issueInvitation,claimInvitation}=require('../services/reseller-invitation-service');

const eur=z.union([z.string(),z.number().transform(String)]).pipe(z.string().regex(/^\d{1,5}(\.\d{1,2})?$/)).refine(value=>Number(value)>0);
const page=z.coerce.number().int().min(0).max(10000).default(0);
const resellerInput=z.object({username:z.string().trim().min(2).max(120),email:z.email().max(255).toLowerCase(),phone:z.string().trim().max(50).default('')}).strict();
const transferInput=z.object({reseller_id:id,amount:eur,expected_cost:eur.optional(),expected_margin_bps:z.number().int().min(0).max(9999).optional()}).strict();

function agentRoutes(pool,key,mailer=null){
  const router=Router();
  const signInRate=rateLimit({windowMs:60000,limit:12,standardHeaders:'draft-8',legacyHeaders:false});
  const inviteRate=rateLimit({windowMs:60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false});
  router.post('/api/agent/login',signInRate,login(pool,key,'agent'));
  router.post('/api/reseller/invitations/claim',signInRate,async(req,res)=>{
    const input=z.object({token:z.string().regex(/^[a-f0-9]{64}$/),password:z.string().min(10).refine(v=>Buffer.byteLength(v)<=72)}).strict().parse(req.body);
    res.json(await claimInvitation(pool,input.token,input.password));
  });
  router.use('/api/agent',authenticate(pool,key,['agent']));
  router.get('/api/agent/overview',async(req,res)=>res.json(await model.overview(pool,req.user.id)));
  router.get('/api/agent/resellers',async(req,res)=>{
    const filters=z.object({search:z.string().trim().max(120).default(''),page}).parse(req.query);
    res.json(await model.resellers(pool,req.user.id,filters));
  });
  router.post('/api/agent/resellers',inviteRate,async(req,res)=>{
    const created=await service.createReseller(pool,req.user.id,resellerInput.parse(req.body));
    let invitation={delivery:'failed'};
    try{invitation=await issueInvitation(pool,created.id,req.user,{mailer});}catch{}
    res.status(201).json({...created,invitation_delivery:invitation.delivery});
  });
  router.post('/api/agent/resellers/:id/invitation',inviteRate,async(req,res)=>{
    z.object({}).strict().parse(req.body??{});
    res.json(await issueInvitation(pool,id.parse(req.params.id),req.user,{mailer}));
  });
  router.post('/api/agent/transfers/quote',async(req,res)=>{
    const input=z.object({reseller_id:id,amount:eur}).strict().parse(req.body);
    res.json(await service.quoteTransfer(pool,req.user.id,input.reseller_id,input.amount));
  });
  router.post('/api/agent/transfers',async(req,res)=>{
    const input=transferInput.parse(req.body);
    const ref=reference.parse(req.get('Idempotency-Key'));
    res.json(await service.transfer(pool,req.user.id,input,ref));
  });
  router.get('/api/agent/transfers',async(req,res)=>res.json(await model.transfers(pool,req.user.id,page.parse(req.query.page))));
  router.get('/api/agent/wallet',async(req,res)=>res.json(await model.entries(pool,req.user.id,page.parse(req.query.page))));
  return router;
}
module.exports={agentRoutes,eur,resellerInput,transferInput};

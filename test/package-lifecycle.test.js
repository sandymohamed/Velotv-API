const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previewRemoval, removePackage, restorePackage } = require('../src/services/package-lifecycle-service');
const { chooseQuote } = require('../src/services/package-offer-service');

function fixture(flags = {}) {
  let state={ pack:{ id:1,package_name:'Annual',created_at:'2026-11-18 12:00:00',archived_at:null,enabled:1 },
    offers:[{id:9,package_id:1,enabled:1}],audience:[{offer_id:9,reseller_id:2}],
    flags, audit:[], devices:[{id:2,expires_at:'2027-11-18'}],codes:[{id:8,duration:12,used:0}],purchases:[{id:'kept',snapshot:'original terms'}] };
  let original;
  const sql=[];
  let failAudit=false;
  const db={
    async beginTransaction(){original=structuredClone(state);},
    async commit(){}, async rollback(){state=original;}, release(){},
    async execute(query,args){
      sql.push(query);
      if(query.startsWith('SELECT id, package_name, created_at')){
        assert.ok(query.endsWith('FOR UPDATE'));return [state.pack?[structuredClone(state.pack)]:[]];
      }
      if(query.includes('AS purchases'))return [[state.flags]];
      if(query.startsWith('UPDATE packages_reseller')){
        state.pack.enabled=0;
        state.pack.archived_at=query.includes('archived_at=NULL')?null:(state.pack.archived_at||'2026-11-18 13:00:00');
        return [{affectedRows:1}];
      }
      if(query.startsWith('UPDATE velotv_package_offers')){state.offers.forEach(row=>row.enabled=0);return [{affectedRows:1}];}
      if(query.startsWith('DELETE r FROM')){state.audience=[];return [{affectedRows:1}];}
      if(query.startsWith('DELETE FROM velotv_package_offers')){state.offers=[];return [{affectedRows:1}];}
      if(query.startsWith('DELETE FROM packages_reseller')){state.pack=null;return [{affectedRows:1}];}
      if(query.startsWith('INSERT INTO velotv_admin_activity')){
        if(failAudit)throw new Error('audit failed');
        state.audit.push({actor:args[0],action:args[1],id:args[2]});return [{insertId:1}];
      }
      throw new Error('Unexpected SQL: '+query);
    },
  };
  return { pool:{async getConnection(){return db;}},get state(){return state;},sql,
    failAudit(){failAudit=true;},setFlags(value){state.flags=value;} };
}

test('unused package and unused offers are permanently removed in one transaction',async()=>{
  const f=fixture();
  const preview=await previewRemoval(f.pool,1);
  assert.equal(preview.action,'deleted');assert.equal(f.state.pack.id,1);
  const result=await removePackage(f.pool,1,3);
  assert.equal(result.action,'deleted');assert.equal(f.state.pack,null);
  assert.deepEqual(f.state.offers,[]);assert.deepEqual(f.state.audience,[]);
  assert.equal(f.state.audit[0].action,'coupon_package_deleted');
  assert.deepEqual(f.state.devices,[{id:2,expires_at:'2027-11-18'}]);
  assert.deepEqual(f.state.codes,[{id:8,duration:12,used:0}]);
});

test('purchases, pending PayPal and legacy references each force archiving',async()=>{
  for(const flag of ['purchases','paypal_orders','legacy_payments','unlinked_coupons','legacy_wallet_operations']){
    const f=fixture({[flag]:1});const kept=structuredClone({codes:f.state.codes,devices:f.state.devices,purchases:f.state.purchases});
    assert.equal((await previewRemoval(f.pool,1)).action,'archived',flag);
    assert.equal((await removePackage(f.pool,1,3)).action,'archived',flag);
    assert.ok(f.state.pack.archived_at);assert.equal(f.state.pack.enabled,0);
    assert.equal(f.state.offers[0].enabled,0);assert.equal(f.state.audience.length,1);
    assert.deepEqual({codes:f.state.codes,devices:f.state.devices,purchases:f.state.purchases},kept);
    assert.ok(!f.sql.some(query=>query.startsWith('DELETE')));
  }
});

test('confirmation rechecks history when a purchase arrives after the preview',async()=>{
  const f=fixture();assert.equal((await previewRemoval(f.pool,1)).action,'deleted');
  f.setFlags({purchases:1});assert.equal((await removePackage(f.pool,1,3)).action,'archived');
  assert.ok(f.state.pack);
});

test('restoring an archived package does not enable sales or revive old offers',async()=>{
  const f=fixture({purchases:1});await removePackage(f.pool,1,3);
  const result=await restorePackage(f.pool,1,3);
  assert.equal(result.action,'restored');assert.equal(f.state.pack.archived_at,null);
  assert.equal(f.state.pack.enabled,0);assert.equal(f.state.offers[0].enabled,0);
  assert.equal((await restorePackage(f.pool,1,3)).action,'already_restored');
});

test('audit failure rolls back permanent deletion and offer cleanup',async()=>{
  const f=fixture();const before=structuredClone(f.state);f.failAudit();
  await assert.rejects(removePackage(f.pool,1,3),/audit failed/);
  assert.deepEqual(f.state,before);
});

test('deletion can be retried without duplicating audit records',async()=>{
  const f=fixture();await removePackage(f.pool,1,3);
  assert.equal((await removePackage(f.pool,1,3)).action,'already_deleted');assert.equal(f.state.audit.length,1);
  await assert.rejects(previewRemoval(f.pool,1),error=>error.status===404);
});

test('archived packages cannot be quoted even when enabled is accidentally true',()=>{
  assert.throws(()=>chooseQuote({id:1,enabled:1,archived_at:'2026-11-18',package_amount:'1',periods:12,count_devices:1},[]),error=>error.status===409);
});

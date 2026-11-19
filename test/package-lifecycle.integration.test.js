const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { connectDatabase } = require('../src/config/database');
const { migrate } = require('../src/config/migrations');
const { previewRemoval, removePackage, restorePackage } = require('../src/services/package-lifecycle-service');
const { manualTopUp, buyCoupons } = require('../src/services/credit-service');
const { createIntent } = require('../src/models/payment-model');
const { quote } = require('../src/services/package-offer-service');

test('MySQL package deletion, archived references and concurrent checkout', {
  skip: !process.env.MYSQL_TEST_URL,
}, async t => {
  const url=new URL(process.env.MYSQL_TEST_URL);
  const database='velo_delete_'+randomUUID().replaceAll('-','');
  url.pathname='/'+database;
  const pool=await connectDatabase({DATABASE_URL:url.href,DB_SSL:'disable',DB_AUTO_CREATE:'true'});
  t.after(async()=>{
    await pool.end();url.pathname='/';const cleanup=await mysql.createConnection(url.href);
    try{await cleanup.query('DROP DATABASE '+mysql.escapeId(database));}finally{await cleanup.end();}
  });
  await migrate(pool);await migrate(pool);
  await pool.execute('INSERT INTO admins(name,email,password) VALUES (?,?,?)',['Test admin','admin@example.test','unused']);
  await pool.execute('INSERT INTO resellers(username,email,password,phone) VALUES (?,?,?,?)',['test-reseller','reseller@example.test','unused','']);
  async function pack(name){
    const [row]=await pool.execute('INSERT INTO packages_reseller(package_name,package_amount,periods,count_devices,id_pay) VALUES (?,1,12,1,0)',[name]);
    return row.insertId;
  }
  const unused=await pack('Unused');
  const [offer]=await pool.execute(`INSERT INTO velotv_package_offers(package_id,name,starts_at,ends_at,offer_amount)
    VALUES (?,'Unused offer',UTC_TIMESTAMP(),UTC_TIMESTAMP()+INTERVAL 1 DAY,1)`,[unused]);
  await pool.execute('INSERT INTO velotv_package_offer_resellers(offer_id,reseller_id) VALUES (?,1)',[offer.insertId]);
  assert.equal((await previewRemoval(pool,unused)).action,'deleted');
  assert.equal((await removePackage(pool,unused,1)).action,'deleted');
  const [[left]]=await pool.execute('SELECT COUNT(*) AS count FROM velotv_package_offer_resellers WHERE offer_id=?',[offer.insertId]);
  assert.equal(left.count,0);

  const used=await pack('Purchased annual activation');
  await manualTopUp(pool,1,{resellerId:1,amount:'10',kind:'gift',reference:'DELETE-QA-GIFT'});
  const purchase=await buyCoupons(pool,1,used,'DELETE-QA-PURCHASE');
  const [beforeCodes]=await pool.execute('SELECT * FROM reseller_packages WHERE purchase_id=?',[purchase.purchase_id]);
  const [[beforePurchase]]=await pool.execute('SELECT snapshot FROM velotv_package_purchases WHERE id=?',[purchase.purchase_id]);
  assert.equal((await removePackage(pool,used,1)).action,'archived');
  const [afterCodes]=await pool.execute('SELECT * FROM reseller_packages WHERE purchase_id=?',[purchase.purchase_id]);
  const [[afterPurchase]]=await pool.execute('SELECT snapshot FROM velotv_package_purchases WHERE id=?',[purchase.purchase_id]);
  assert.deepEqual(afterCodes,beforeCodes);assert.deepEqual(afterPurchase,beforePurchase);
  await assert.rejects(quote(pool,used,1),error=>error.status===409);
  await restorePackage(pool,used,1);
  const [[restored]]=await pool.execute('SELECT archived_at,enabled FROM packages_reseller WHERE id=?',[used]);
  assert.equal(restored.archived_at,null);assert.equal(restored.enabled,0);

  const pending=await pack('Pending PayPal');
  const orderId=randomUUID();
  await createIntent(pool,{id:orderId,resellerId:1,purpose:'package',packageId:pending,duration:12,couponCount:1,amount:'1.00',currency:'EUR'});
  assert.equal((await removePackage(pool,pending,1)).action,'archived');
  const [[order]]=await pool.execute('SELECT * FROM velotv_paypal_orders WHERE id=?',[orderId]);
  assert.ok(order);assert.equal(order.package_id,pending);

  const race=await pack('Concurrent package');
  const results=await Promise.allSettled([buyCoupons(pool,1,race,'DELETE-QA-RACE'),removePackage(pool,race,1)]);
  assert.equal(results[1].status,'fulfilled');
  const [racePurchases]=await pool.execute('SELECT * FROM velotv_package_purchases WHERE package_id=?',[race]);
  const [[racePackage]]=await pool.execute('SELECT * FROM packages_reseller WHERE id=?',[race]);
  if(racePurchases.length){assert.ok(racePackage.archived_at);assert.equal(results[1].value.action,'archived');}
  else{assert.equal(racePackage,undefined);assert.equal(results[1].value.action,'deleted');assert.equal(results[0].status,'rejected');}
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { connectDatabase } = require('../src/config/database');
const { migrate } = require('../src/config/migrations');
const { createApp } = require('../src/app');

test('MySQL offer checkout, concurrency, audience, snapshots and PayPal reservations', {
  skip: !process.env.MYSQL_TEST_URL,
}, async t => {
  const url = new URL(process.env.MYSQL_TEST_URL);
  const database = 'velo_offers_' + randomUUID().replaceAll('-', '');
  url.pathname = '/' + database;
  const pool = await connectDatabase({ DATABASE_URL: url.href, DB_SSL: 'disable', DB_AUTO_CREATE: 'true' });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    url.pathname = '/';
    const cleanup = await mysql.createConnection(url.href);
    try { await cleanup.query('DROP DATABASE ' + mysql.escapeId(database)); }
    finally { await cleanup.end(); }
  });
  await migrate(pool);
  await migrate(pool);
  const password = 'temporary-test-password-123';
  const hash = await bcrypt.hash(password, 4);
  await pool.execute('INSERT INTO admins(name,password,email) VALUES (?,?,?)', ['Admin',hash,'admin@example.test']);
  for (let i=1;i<=2;i++) await pool.execute('INSERT INTO resellers(username,email,password,phone) VALUES (?,?,?,?)', [`r${i}`,`r${i}@example.test`,hash,'']);
  const remoteOrders = new Map();
  const paypal = {
    merchantId: 'TEST_MERCHANT', successUrl: 'https://example.test/success',
    async create(order) {
      const id = 'ORDER' + (remoteOrders.size+1) + 'TEST';
      remoteOrders.set(id, { order, status: 'APPROVED' });
      return { id,redirectUrl: 'https://example.test/' + id };
    },
    async capture(id) { remoteOrders.get(id).status = 'COMPLETED'; },
    async read(id) {
      const { order,status } = remoteOrders.get(id);
      return { id,status,purchase_units: [{ custom_id: order.id, payee: { merchant_id: 'TEST_MERCHANT' },
        payments: { captures: [{ id: 'CAPTURE'+id,status,amount: { value: order.amount,currency_code: 'EUR' } }] } }] };
    },
  };
  server = createApp(pool,'d'.repeat(64),paypal).listen(0,'127.0.0.1');
  await once(server,'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(method,path,body,token,reference) {
    const res = await fetch(base+path,{ method,redirect:'manual',headers: {
      ...(body && { 'Content-Type':'application/json' }),
      ...(token && { Authorization:'Bearer '+token }),
      ...(reference && { 'Idempotency-Key':reference }),
    },...(body && { body: JSON.stringify(body) }) });
    return { status:res.status,data:res.status===303 ? null : await res.json() };
  }
  const admin = (await call('POST','/api/admin/login',{ email:'admin@example.test',password })).data.result;
  const r1 = (await call('POST','/reseller/user/login',{ username:'r1',password })).data.result;
  const r2 = (await call('POST','/reseller/user/login',{ username:'r2',password })).data.result;
  const prefix = '/api/admin/console/';
  const trial = { package_name:'Trial',package_amount:2,periods:1,count_devices:3,enabled:true,offer_only:true };
  const created = await call('POST',prefix+'coupon-packages',trial,admin);
  assert.equal(created.status,201);
  const packageId = created.data.id;
  const input = { name:'Launch',enabled:true,starts_at:new Date(Date.now()-60000).toISOString(),
    ends_at:new Date(Date.now()+86400000).toISOString(),offer_amount:1,
    max_purchases_per_reseller:1,audience:'selected',reseller_ids:[1] };
  const offer = await call('POST',`${prefix}coupon-packages/${packageId}/offers`,input,admin);
  assert.equal(offer.status,201);
  const offerId = offer.data.id;
  assert.equal((await call('POST',`${prefix}coupon-packages/${packageId}/offers`,input,r1)).status,403);
  assert.equal((await call('GET','/reseller/dashboard/catalog',null,r1)).data.packages[0].package_amount,'1.000');
  assert.equal((await call('GET','/reseller/dashboard/catalog',null,r2)).data.packages.length,0);
  await call('POST','/reseller/paybalance/newbalance',{ reseller_id:1,amount:'1',kind:'gift',paymentId:'GIFT-OFFERS-1' },admin);
  const payload = { package:packageId,offer_id:offerId };
  const concurrent = await Promise.all([
    call('POST','/reseller/coupon',payload,r1,'OFFER-BUY-ONE'),
    call('POST','/reseller/coupon',payload,r1,'OFFER-BUY-TWO'),
  ]);
  assert.deepEqual(concurrent.map(row=>row.status).sort(),[200,409]);
  const successIndex = concurrent.findIndex(row=>row.status===200);
  const ref = successIndex===0 ? 'OFFER-BUY-ONE' : 'OFFER-BUY-TWO';
  const replay = await call('POST','/reseller/coupon',payload,r1,ref);
  assert.equal(replay.status,200);
  assert.equal(replay.data.purchase_id,concurrent[successIndex].data.purchase_id);
  let [[coupons]] = await pool.execute('SELECT COUNT(*) AS count FROM reseller_packages WHERE id_reseller=1');
  assert.equal(coupons.count,3);
  await call('PATCH',prefix+`coupon-packages/${packageId}`,{ ...trial,package_name:'Changed',package_amount:50,periods:12,count_devices:20 },admin);
  const history = await call('GET',prefix+'package-purchases?reseller_id=1',null,admin);
  assert.equal(history.data.count,1);
  const purchase = history.data.rows[0];
  const snapshot = typeof purchase.snapshot==='string' ? JSON.parse(purchase.snapshot) : purchase.snapshot;
  assert.equal(snapshot.package_name,'Trial');
  assert.equal(snapshot.periods,1);
  assert.equal(snapshot.count_devices,3);
  assert.equal(Number(snapshot.amount),1);
  assert.equal((await call('GET','/reseller/dashboard/package-purchases?reseller_id=1',null,r2)).data.count,0);
  await call('PATCH',prefix+`package-offers/${offerId}`,{ ...input,enabled:false },admin);
  assert.equal((await call('POST','/reseller/coupon',payload,r2,'UNAUTHORIZED')).status,409);

  // PayPal reserves a slot before approval, and paid terms survive later edits.
  const ppPackage = (await call('POST',prefix+'coupon-packages',{ ...trial,package_name:'PayPal Trial' },admin)).data.id;
  const ppOffer = (await call('POST',`${prefix}coupon-packages/${ppPackage}/offers`,{ ...input,reseller_ids:[2] },admin)).data.id;
  const ppPayload = { package_id:ppPackage,offer_id:ppOffer };
  const pp = await call('POST','/reseller/pay/paypal/pay',ppPayload,r2);
  assert.equal(pp.status,200);
  assert.equal((await call('POST','/reseller/pay/paypal/pay',ppPayload,r2)).status,409);
  assert.equal((await call('POST','/reseller/coupon',{ package:ppPackage,offer_id:ppOffer },r2,'CROSS-CHANNEL')).status,409);
  await call('PATCH',prefix+`package-offers/${ppOffer}`,{ ...input,reseller_ids:[2],enabled:false },admin);
  await call('PATCH',prefix+`coupon-packages/${ppPackage}/availability`,{ enabled:false,offer_only:true },admin);
  await call('PATCH',prefix+`coupon-packages/${ppPackage}`,{ ...trial,package_amount:99,periods:12,count_devices:20,enabled:false },admin);
  const remoteId = [...remoteOrders.keys()][0];
  assert.equal((await call('GET','/reseller/pay/paypal/success?token='+remoteId)).status,303);
  assert.equal((await call('GET','/reseller/pay/paypal/success?token='+remoteId)).status,303);
  [[coupons]] = await pool.execute('SELECT COUNT(*) AS count, MIN(duration) AS duration FROM reseller_packages WHERE id_reseller=2');
  assert.equal(coupons.count,3);
  assert.equal(coupons.duration,1);
  const [[stored]] = await pool.execute('SELECT * FROM velotv_package_purchases WHERE id=?',[pp.data.purchase_id]);
  assert.equal(stored.status,'fulfilled');
  assert.equal(Number(stored.amount),1);
});

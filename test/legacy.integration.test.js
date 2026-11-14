const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { generateKeyPairSync, randomUUID, sign } = require('node:crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { connectDatabase } = require('../src/config/database');
const { migrate } = require('../src/config/migrations');
const { createApp } = require('../src/app');

test('legacy MySQL schema, manual credits, PayPal and coupon redemption', {
  skip: !process.env.MYSQL_TEST_URL,
}, async t => {
  const url = new URL(process.env.MYSQL_TEST_URL);
  const dbName = 'velo_qa_' + randomUUID().replaceAll('-', '');
  url.pathname = '/' + dbName;
  const pool = await connectDatabase({ DATABASE_URL: url.href, DB_SSL: 'disable', DB_AUTO_CREATE: 'true' });
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await pool.end();
    url.pathname = '/';
    const maintenance = await mysql.createConnection(url.href);
    try { await maintenance.query('DROP DATABASE ' + mysql.escapeId(dbName)); }
    finally { await maintenance.end(); }
  });
  await pool.query(`CREATE TABLE velotv_schema_migrations (
    filename VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied BOOLEAN NOT NULL DEFAULT FALSE
  ) ENGINE=InnoDB`);
  const oldChecksum = '822684b4683e3262f03dfa32ef4f13648e742b10bd6ca403e4d6adcff3c35c94';
  await pool.execute('INSERT INTO velotv_schema_migrations(filename, checksum) VALUES (?, ?)',
    ['001_legacy_schema.sql', oldChecksum]);
  await migrate(pool);
  const [[bootstrap]] = await pool.execute('SELECT checksum, applied FROM velotv_schema_migrations WHERE filename = ?',
    ['001_legacy_schema.sql']);
  assert.equal(bootstrap.applied, 1);
  assert.notEqual(bootstrap.checksum, oldChecksum);
  await migrate(pool);
  const [[{ count }]] = await pool.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE()');
  assert.equal(count, 39);
  const pass = 'temporary-example-password';
  const hash = await bcrypt.hash(pass, 4);
  await pool.execute('INSERT INTO admins(name,password,email) VALUES (?,?,?)', ['Admin', hash, 'admin@example.test']);
  await pool.execute('INSERT INTO resellers(username,email,password,phone) VALUES (?,?,?,?)', ['Reseller', 'reseller@example.test', hash, '']);
  await pool.execute('INSERT INTO packages_reseller(package_name,package_amount,periods,count_devices,id_pay) VALUES (?,?,?,?,?)',
    ['Starter', '8.000', 1, 1, 1]);
  const mac = 'aa:bb:cc:dd:ee:01';
  await pool.execute('INSERT INTO devices(mac,password,type,status) VALUES (?,?,?,?)', [mac, hash, 1, 0]);
  await pool.execute('INSERT INTO profiles(profile_name,id_device,host) VALUES (?,?,?)', ['Example', '1', 'https://example.test']);
  const orders = new Map();
  const paypal = {
    merchantId: 'QA_MERCHANT',
    successUrl: 'https://example.test/success',
    async create(order) {
      const id = 'PAYPALORDER' + (orders.size + 1);
      orders.set(id, { order, status: 'APPROVED' });
      return { id, redirectUrl: 'https://example.test/' + id };
    },
    async capture(id) { orders.get(id).status = 'COMPLETED'; },
    async read(id) {
      const { order, status } = orders.get(id);
      return { id, status, purchase_units: [{
        custom_id: order.id, payee: { merchant_id: 'QA_MERCHANT' },
        payments: { captures: [{
          id: 'CAPTURE' + id, status,
          amount: { value: order.amount, currency_code: 'EUR' },
        }] },
      }] };
    },
  };
  server = createApp(pool, 'c'.repeat(64), paypal).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function call(method, path, status, body, token, extra) {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: 'Bearer ' + token }), ...extra,
    }, ...(body && { body: JSON.stringify(body) }) });
    const data = response.status === 303 ? null : await response.json();
    assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    return data;
  }
  const post = (path, status, body, token, headers) => call('POST', path, status, body, token, headers);
  const trialPath = '/api/apps/entitlements/trial';
  const trialDevice = { android_id: '8ac13099bc22de09' };
  const trial = (await post(trialPath, 200, trialDevice)).grant;
  assert.equal(trial.source, 'trial');
  assert.ok(trial.expiresAt > Date.now() + 6 * 86400000);
  assert.equal((await post(trialPath, 200, trialDevice)).grant.expiresAt, trial.expiresAt);
  await pool.execute('UPDATE velotv_standalone_trials SET expires_at = UTC_TIMESTAMP()');
  assert.equal((await post(trialPath, 200, trialDevice)).grant, null);
  await post('/api/apps/entitlements/google-play', 503, { ...trialDevice, purchase_token: 'test' });
  const admin = (await post('/api/admin/login', 200, { email: 'admin@example.test', password: pass })).result;
  const reseller = (await post('/reseller/service/login', 200, { email: 'reseller@example.test', password: pass })).result;
  await post('/api/admin/login', 202, { email: 'admin@example.test', password: 'bad' });
  await post('/api/admin/login', 202, { email: "' OR 1=1 --", password: pass });
  const creditPath = '/reseller/paybalance/newbalance';
  const payment = { reseller_id: 1, amount: '10', paymentId: 'WIRE-1', kind: 'manual_paid', paidAmount: '10', currency: 'EUR' };
  await post(creditPath, 403, payment, reseller);
  const duplicate = await Promise.all([post(creditPath, 200, payment, admin), post(creditPath, 200, payment, admin)]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  await post(creditPath, 409, { ...payment, amount: '11' }, admin);
  await post(creditPath, 200, { reseller_id: 1, amount: '1', paymentId: 'GIFT-1', kind: 'gift' }, admin);
  const order = { package: 1 };
  const headers = { 'Idempotency-Key': 'ORDER-1' };
  await Promise.all([post('/reseller/coupon', 200, order, reseller, headers), post('/reseller/coupon', 200, order, reseller, headers)]);
  await post('/reseller/coupon', 400, order, reseller);
  assert.equal((await call('GET', '/reseller/service/CurrentSolde', 200, null, reseller)).solde, '3.00000');
  const coupons = await call('GET', '/reseller/coupon', 200, null, reseller);
  assert.equal(coupons.result.length, 1);
  const redeem = { mac, password: pass, id_coupon: coupons.result[0].id };
  await post('/reseller/devices/redeemed', 200, redeem, reseller);
  await post('/reseller/devices/redeemed', 409, redeem, reseller);
  const device = await post('/api/apps/devices/login', 200, { mac, password: pass, type: 1, version: "'1.0'" });
  assert.equal(device.status, 1);
  assert.equal(device.playlist.length, 1);
  await post('/reseller/paybalance/paypal/pay', 200, { amount: '2.00' }, reseller);
  const callback = '/reseller/paybalance/paypal/success?token=PAYPALORDER1';
  await Promise.all([call('GET', callback, 303), call('GET', callback, 303)]);
  assert.equal((await call('GET', '/reseller/service/CurrentSolde', 200, null, reseller)).solde, '5.00000');
  await post('/reseller/pay/paypal/pay', 200, { package_id: 1, amount: '0.01' }, reseller);
  assert.equal(orders.get('PAYPALORDER2').order.amount, '8.00');
  await call('GET', '/reseller/pay/paypal/success?token=PAYPALORDER2', 303);
  assert.equal((await call('GET', '/reseller/coupon', 200, null, reseller)).result.length, 2);
  const androidId = '8ac13099bc22de01';
  const android = { android_id: androidId, type: 1 };
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const public_key = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const challengePath = '/api/apps/devices/challenge';
  const loginPath = '/api/apps/devices/login';
  const makeLogin = async () => {
    const { challenge } = await post(challengePath, 200, { ...android, public_key });
    const message = Buffer.from(`velotv-device-login-v1:${androidId}:1:${challenge}`);
    return { ...android, challenge, signature: sign('sha256', message, pair.privateKey).toString('base64') };
  };
  const unused = (await call('GET', '/reseller/coupon?used=0', 200, null, reseller)).result[0];
  const redemption = { ...android, id_coupon: unused.id };
  const firstLogin = await makeLogin();
  await post('/reseller/devices/redeemed', 403, redemption, reseller);
  await post(loginPath, 400, { ...android, password: 'legacy' });
  assert.equal((await post(loginPath, 200, firstLogin)).status, -1);
  await post(loginPath, 401, firstLogin);
  await post('/reseller/devices/redeemed', 200, redemption, reseller);
  const found = await call('GET', '/reseller/coupon?search=' + androidId, 200, null, reseller);
  assert.equal(found.result[0].android_id, androidId);
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await post(challengePath, 409, { ...android,
    public_key: other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  const activeAndroid = await post(loginPath, 200, await makeLogin());
  assert.equal(activeAndroid.status, 1);
  assert.equal(activeAndroid.mac, null);
  assert.equal(activeAndroid.android_id, androidId);
  assert.equal(activeAndroid.android_public_key, undefined);
  assert.equal(activeAndroid.android_challenge, undefined);
  const history = await call('GET', '/reseller/service/payment', 200, null, reseller);
  assert.equal(history.data.length, 4);
  await call('GET', '/api/admin/resellers/1/credit-report', 403, null, reseller);
  const report = await call('GET', '/api/admin/resellers/1/credit-report', 200, null, admin);
  assert.equal(report.packagePayments.length, 1);
  assert.equal(report.activations.length, 2);
  assert.deepEqual(report.payments.map(p => p.methode), ['PAYPAL', 'GIFT', 'MANUAL_PAID']);
  const [[{ gift }]] = await pool.execute("SELECT payment_amount AS gift FROM payment_services WHERE methode = 'GIFT'");
  assert.equal(gift, '0.00000');
});

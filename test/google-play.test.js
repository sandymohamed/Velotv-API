const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createGooglePlay } = require('../src/services/google-play-service');

test('Play verifies device, product, monthly plan, purchase state and acknowledgement', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'velo-play-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const keyPath = join(folder, 'service-account.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(keyPath, JSON.stringify({
    client_email: 'test@example.invalid',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
  }));
  const androidId = '8ac13099bc22de01';
  const purchase = {
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: createHash('sha256').update('velotv-device:' + androidId).digest('hex'),
    },
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    lineItems: [{
      productId: 'velotv_monthly',
      expiryTime: new Date(Date.now() + 86400000).toISOString(),
      offerDetails: { basePlanId: 'monthly' },
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
  };
  let acknowledgements = 0;
  let authorizations = 0;
  const verify = createGooglePlay({
    GOOGLE_PLAY_PRODUCT_ID: 'velotv_monthly',
    GOOGLE_PLAY_BASE_PLAN_ID: 'monthly',
    GOOGLE_PLAY_SERVICE_ACCOUNT_FILE: keyPath,
  }, async (url, options) => {
    if (url.includes('oauth2.googleapis.com')) {
      authorizations++;
      assert.equal(options.method, 'POST');
      return Response.json({ access_token: 'test-access', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    assert.match(url, /com\.velotv\.player/);
    if (url.endsWith(':acknowledge')) {
      acknowledgements++;
      assert.equal(options.method, 'POST');
      return new Response(null, { status: 204 });
    }
    assert.match(url, /subscriptionsv2\/tokens\/test-token$/);
    return Response.json(purchase);
  });
  assert.equal((await verify(androidId, 'test-token')).status, 'active');
  assert.equal(acknowledgements, 1);
  assert.equal(await verify('deadbeef00000001', 'test-token'), null);
  purchase.subscriptionState = 'SUBSCRIPTION_STATE_ON_HOLD';
  assert.equal(await verify(androidId, 'test-token'), null);
  purchase.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
  purchase.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  assert.equal((await verify(androidId, 'test-token')).autoRenewing, true);
  purchase.lineItems[0].offerDetails.basePlanId = 'annual';
  assert.equal(await verify(androidId, 'test-token'), null);
  assert.equal(acknowledgements, 1);
  assert.equal(authorizations, 1);
});

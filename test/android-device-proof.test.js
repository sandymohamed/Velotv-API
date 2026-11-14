const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generateKeyPairSync, sign } = require('node:crypto');
const { authenticateAndroid, normalizePublicKey } = require('../src/services/android-device-proof');

test('Android login requires a signature for this device and consumes the challenge once', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(normalizePublicKey(encoded), encoded);
  assert.throws(() => normalizePublicKey('aW52YWxpZA=='), { status: 400 });
  const input = { android_id: '8ac13099bc22de01', type: 1, challenge: 'b'.repeat(64) };
  const device = { id: 3, android_public_key: encoded, android_challenge: input.challenge };
  let spent = false;
  const db = {
    async execute(sql, params) {
      if (sql.startsWith('SELECT')) {
        assert.deepEqual(params, [input.android_id, input.type]);
        return [[device]];
      }
      assert.match(sql, /android_challenge_expires_at > UTC_TIMESTAMP/);
      assert.deepEqual(params, [device.id, encoded, input.challenge]);
      if (spent) return [{ affectedRows: 0 }];
      spent = true;
      return [{ affectedRows: 1 }];
    },
  };
  function signature(value) {
    return sign('sha256', Buffer.from(value), privateKey).toString('base64');
  }
  assert.equal(await authenticateAndroid(db, { ...input, signature: signature('unrelated') }), null);
  const request = { ...input, signature: signature(`velotv-device-login-v1:${input.android_id}:1:${input.challenge}`) };
  const results = await Promise.all([authenticateAndroid(db, request), authenticateAndroid(db, request)]);
  assert.equal(results.filter(Boolean).length, 1);
});

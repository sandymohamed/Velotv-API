const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');
const { issueRecoveryCode, recoverDevice } = require('../src/services/android-device-recovery');

function installation() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { ...pair, publicKey };
}

test('recovery code rebinds an active device without altering expiry and is consumed once', async () => {
  const oldKey = installation();
  const newKey = installation();
  const identity = { android_id: '5194a8c538a286d1', type: 1 };
  const expiry = '2035-01-01T10:00:00Z';
  const row = { id: 9, ...identity, status: 1, ExipiredAt: expiry, android_public_key: oldKey.publicKey };
  const db = {
    async execute(sql, params) {
      if (sql.startsWith('SELECT * FROM devices')) {
        assert.deepEqual(params, [identity.android_id, identity.type]);
        return [[{ ...row }]];
      }
      if (sql.startsWith('UPDATE devices SET android_recovery_digest')) {
        assert.equal(params[1], row.id);
        row.android_recovery_digest = params[0];
      } else if (sql.startsWith('UPDATE devices SET android_public_key')) {
        assert.equal(params[1], row.id);
        assert.ok(sql.includes('android_recovery_digest = NULL'));
        assert.ok(sql.includes('android_verified_at = NULL'));
        assert.ok(!sql.includes('ExipiredAt'));
        Object.assign(row, { android_public_key: params[0], android_recovery_digest: null, android_verified_at: null });
      } else {
        assert.ok(sql.includes('android_challenge_expires_at > UTC_TIMESTAMP()'));
        assert.deepEqual(params, [row.id, row.android_public_key, row.android_challenge]);
        row.android_challenge = null;
      }
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
  };
  const pool = { ...db, async getConnection() { return db; } };
  function proof(key) {
    const challenge = 'ab'.repeat(32);
    row.android_challenge = challenge;
    const message = Buffer.from(`velotv-device-login-v1:${identity.android_id}:1:${challenge}`);
    return { ...identity, challenge, signature: sign('sha256', message, key.privateKey).toString('base64') };
  }
  await assert.rejects(issueRecoveryCode(pool, proof(newKey)), { status: 401 });
  const first = await issueRecoveryCode(pool, proof(oldKey));
  const latest = await issueRecoveryCode(pool, proof(oldKey));
  assert.match(latest.code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/);
  const request = code => ({ ...identity, public_key: newKey.publicKey, code: code.replaceAll('-', '') });
  await assert.rejects(recoverDevice(pool, request(first.code)), { status: 409 });
  row.ExipiredAt = '2000-01-01T00:00:00Z';
  await assert.rejects(recoverDevice(pool, request(latest.code)), { status: 409 });
  row.ExipiredAt = expiry;
  assert.deepEqual(await recoverDevice(pool, request(latest.code)), { success: true });
  assert.equal(row.android_public_key, newKey.publicKey);
  assert.equal(row.ExipiredAt, expiry);
  assert.equal(row.status, 1);
  await assert.rejects(recoverDevice(pool, request(latest.code)), { status: 409 });
  await assert.rejects(issueRecoveryCode(pool, proof(oldKey)), { status: 401 });
  await issueRecoveryCode(pool, proof(newKey));
});

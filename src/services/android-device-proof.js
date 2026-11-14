const { createPublicKey, randomBytes, verify } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { transaction } = require('../config/database');
const { findAndroidDevice } = require('../models/device-model');
const { HttpError } = require('../utils/errors');

function normalizePublicKey(value) {
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1') {
      return key.export({ format: 'der', type: 'spki' }).toString('base64');
    }
  } catch {}
  throw new HttpError(400, 'Invalid Android public key');
}

async function issueAndroidChallenge(pool, input) {
  const { android_id, type, legacy_password } = input;
  const publicKey = normalizePublicKey(input.public_key);
  return transaction(pool, async db => {
    // The unique Android ID/type index serializes concurrent first registrations.
    await db.execute(`INSERT INTO devices (android_id, type, mac, password, status, android_public_key)
      VALUES (?, ?, NULL, '', 0, ?) ON DUPLICATE KEY UPDATE id = id`, [android_id, type, publicKey]);
    const device = await findAndroidDevice(db, android_id, type, true);
    if (device.android_public_key && device.android_public_key !== publicKey) {
      throw new HttpError(409, 'Device key changed. Contact your provider to recover this device.');
    }
    if (!device.android_public_key && !(legacy_password && device.password &&
      await bcrypt.compare(legacy_password, device.password))) {
      throw new HttpError(409, 'Existing device needs provider-assisted key enrollment.');
    }
    const nonce = randomBytes(32).toString('hex');
    await db.execute(`UPDATE devices SET android_public_key = ?,
      android_challenge = IF(android_challenge_expires_at > UTC_TIMESTAMP(), android_challenge, ?),
      android_challenge_expires_at = IF(android_challenge_expires_at > UTC_TIMESTAMP(),
        android_challenge_expires_at, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 MINUTE)) WHERE id = ?`,
    [publicKey, nonce, device.id]);
    const [[issued]] = await db.execute('SELECT android_challenge AS challenge FROM devices WHERE id = ?', [device.id]);
    return issued;
  });
}

async function authenticateAndroid(pool, input) {
  const device = await findAndroidDevice(pool, input.android_id, input.type);
  if (!device?.android_public_key || device.android_challenge !== input.challenge) return null;
  const message = Buffer.from(`velotv-device-login-v1:${input.android_id}:${input.type}:${input.challenge}`);
  const key = { key: Buffer.from(device.android_public_key, 'base64'), format: 'der', type: 'spki' };
  if (!verify('sha256', message, key, Buffer.from(input.signature, 'base64'))) return null;
  const [consumed] = await pool.execute(`UPDATE devices SET android_challenge = NULL, android_challenge_expires_at = NULL, android_verified_at = UTC_TIMESTAMP()
    WHERE id = ? AND android_public_key = ? AND android_challenge = ?
      AND android_challenge_expires_at > UTC_TIMESTAMP()`, [device.id, device.android_public_key, input.challenge]);
  return consumed.affectedRows === 1 ? device : null;
}

module.exports = { normalizePublicKey, issueAndroidChallenge, authenticateAndroid };

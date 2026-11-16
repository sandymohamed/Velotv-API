const { createHash, randomBytes } = require('node:crypto');
const { transaction } = require('../config/database');
const { findAndroidDevice, isActiveDevice } = require('../models/device-model');
const { HttpError } = require('../utils/errors');
const { authenticateAndroid, normalizePublicKey } = require('./android-device-proof');

const digest = value => createHash('sha256').update('velotv-device-recovery-v1:' + value).digest('hex');

async function issueRecoveryCode(pool, input) {
  const verified = await authenticateAndroid(pool, input);
  if (!verified) throw new HttpError(401, 'Device verification failed. Try again.');
  const code = randomBytes(10).toString('hex').toUpperCase();
  return transaction(pool, async db => {
    const current = await findAndroidDevice(db, input.android_id, input.type, true);
    if (!current || current.id !== verified.id ||
        current.android_public_key !== verified.android_public_key || !isActiveDevice(current)) {
      throw new HttpError(409, 'An active device is required to create a recovery code.');
    }
    await db.execute('UPDATE devices SET android_recovery_digest = ? WHERE id = ?', [digest(code), current.id]);
    return { code: code.match(/.{4}/g).join('-') };
  });
}

async function recoverDevice(pool, input) {
  const publicKey = normalizePublicKey(input.public_key);
  return transaction(pool, async db => {
    const current = await findAndroidDevice(db, input.android_id, input.type, true);
    if (!current || current.android_recovery_digest !== digest(input.code) || !isActiveDevice(current)) {
      throw new HttpError(409, 'Recovery code is invalid, already used, or the activation has expired.');
    }
    await db.execute(`UPDATE devices SET android_public_key = ?, android_recovery_digest = NULL,
      android_challenge = NULL, android_challenge_expires_at = NULL, android_verified_at = NULL WHERE id = ?`,
    [publicKey, current.id]);
    return { success: true };
  });
}

module.exports = { issueRecoveryCode, recoverDevice };

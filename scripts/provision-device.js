const { z } = require('zod');
const { connectDatabase } = require('../src/config/database');
const { androidId, id } = require('../src/utils/validation');
const { normalizePublicKey } = require('../src/services/android-device-proof');

const input = z.object({ androidId, type: id, existingId: id, publicKey: z.string().min(1).max(160) });

async function main() {
  const data = input.parse({
    androidId: process.env.ANDROID_ID,
    type: process.env.DEVICE_TYPE,
    existingId: process.env.EXISTING_DEVICE_ID,
    publicKey: process.env.ANDROID_PUBLIC_KEY,
  });
  const key = normalizePublicKey(data.publicKey);
  const pool = await connectDatabase();
  try {
    const [result] = await pool.execute(`UPDATE devices SET android_id = ?, android_public_key = ?,
      android_recovery_digest = NULL, android_challenge = NULL, android_challenge_expires_at = NULL, android_verified_at = NULL
      WHERE id = ? AND type = ? AND (android_id IS NULL OR android_id = ?)`,
    [data.androidId, key, data.existingId, data.type, data.androidId]);
    if (result.affectedRows !== 1) throw new Error('The existing device ID, type, or Android ID does not match');
    console.log('Android device key enrolled.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Device enrollment failed:', error.code === 'ER_DUP_ENTRY'
    ? 'Android ID is already assigned to this device type'
    : error.code || (error instanceof z.ZodError
      ? 'Set ANDROID_ID, DEVICE_TYPE, EXISTING_DEVICE_ID and ANDROID_PUBLIC_KEY'
      : error.message));
  process.exitCode = 1;
});

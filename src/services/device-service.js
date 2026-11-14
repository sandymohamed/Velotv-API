const bcrypt = require('bcryptjs');
const { HttpError } = require('../utils/errors');
const { transaction } = require('../config/database');
const devices = require('../models/device-model');
const coupons = require('../models/coupon-model');
const { authenticateAndroid } = require('./android-device-proof');

function findDevice(db, input, lock = false) {
  if (input.android_id) return devices.findAndroidDevice(db, input.android_id, input.type, lock);
  return devices.findDevice(db, input.mac, input.type, lock);
}

async function redeemCoupon(pool, resellerId, input) {
  return transaction(pool, async db => {
    const coupon = await coupons.lockCoupon(db, resellerId, input.id_coupon);
    if (!coupon || coupon.used !== 0 || coupon.duration < 1 || coupon.duration > 120) {
      throw new HttpError(409, 'Coupon unavailable');
    }
    const device = await findDevice(db, input, true);
    console.log("Device:", device);
    console.log("input.android_id:", input.android_id);
    const authenticated = device && (input.android_id
      ? Boolean(device.android_verified_at)
      : await bcrypt.compare(input.password, device.password));
    if (!authenticated) {
      throw new HttpError(403, '** Device authentication failed');
    }
    if (!(await coupons.redeem(db, resellerId, device.id, coupon))) throw new HttpError(409, 'Coupon unavailable');
    return { error: false, result: 'success redeemeded  device ', message: 'success' };
  });
}

async function loginDevice(pool, input) {
  const device = input.android_id ? await authenticateAndroid(pool, input) : await findDevice(pool, input);
  if (!device || (!input.android_id && !(await bcrypt.compare(input.password, device.password)))) {
    throw new HttpError(401, 'Device authentication failed');
  }
  const {
    password: _password, android_id, android_public_key: _key,
    android_challenge: _challenge, android_challenge_expires_at: _challengeExpiry,
    android_verified_at: _verified, ...info
  } = device;
  const expiry = device.ExipiredAt;
  const normalized = expiry?.replace(' ', 'T');
  const expiryMs = normalized && Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(normalized) ? normalized : normalized + 'Z');
  const active = device.status === 1 && expiryMs > Date.now();
  const rows = active ? await devices.listProfiles(pool, device.id) : [];
  const playlist = rows.map(item => ({ ...item, isXS: Number(item.isXS), pin: '', allowed_output_formats: ['m3u'] }));
  return {
    ...info, ...(input.android_id && { android_id }), password: '', status: active ? 1 : -1,
    version: input.version.replace(/^'|'$/g, ''), is_terial: false, playlist,
    city: { city: '', lat: '', lng: '', iso2: '' },
  };
}
module.exports = { redeemCoupon, loginDevice };

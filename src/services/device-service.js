const { activeReseller } = require('../services/reseller-access');
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

async function redeemCoupon(pool, resellerId, input, { register = false } = {}) {
  return transaction(pool, async db => {
    if (!(await activeReseller(db, resellerId, true))) throw new HttpError(403, 'Reseller access is inactive');
    const coupon = await coupons.lockCoupon(db, resellerId, input.id_coupon);
    if (!coupon || coupon.used !== 0 || coupon.duration < 1 || coupon.duration > 120) {
      throw new HttpError(409, 'Coupon unavailable');
    }
    if (register && input.android_id) await devices.ensureAndroidDevice(db, input.android_id, input.type);
    const device = await findDevice(db, input, true);
    if (!device && input.android_id) throw new HttpError(404, 'Device not registered. Use Register & activate.');
    if (!device || (!input.android_id && !(await bcrypt.compare(input.password, device.password)))) {
      throw new HttpError(403, 'Device authentication failed');
    }
    if (!(await coupons.redeem(db, resellerId, device.id, coupon))) throw new HttpError(409, 'Coupon unavailable');
    return { error: false, result: 'success redeemeded  device ', message: 'success' };
  });
}

async function loginDevice(pool, input) {
  let device = input.signature ? await authenticateAndroid(pool, input) : await findDevice(pool, input);
  if (!device && input.android_id && !input.signature) {
    await devices.ensureAndroidDevice(pool, input.android_id, input.type);
    device = await findDevice(pool, input);
  }
  if (!device || (!input.android_id && !(await bcrypt.compare(input.password, device.password)))) {
    throw new HttpError(401, 'Device authentication failed');
  }
  const {
    password: _password, android_id, android_public_key: _key,
    android_challenge: _challenge, android_challenge_expires_at: _challengeExpiry,
    android_verified_at: _verified, android_recovery_digest: _recovery, ...info
  } = device;
  const active = devices.isActiveDevice(device);
  const rows = active || input.android_id ? await devices.listProfiles(pool, device.id, !active) : [];
  const playlist = rows.map(item => ({ ...item, isXS: Number(item.isXS), pin: '', allowed_output_formats: ['m3u'] }));
  return {
    ...info, ...(input.android_id && { android_id }), password: '', status: active ? 1 : -1,
    version: input.version.replace(/^'|'$/g, ''), is_terial: false, playlist,
    city: { city: '', lat: '', lng: '', iso2: '' },
  };
}
module.exports = { redeemCoupon, loginDevice };

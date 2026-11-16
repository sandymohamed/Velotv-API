const { z } = require('zod');
const { id, mac, androidId } = require('../utils/validation');
const service = require('../services/device-service');
const { listCoupons } = require('../models/coupon-model');

const { issueAndroidChallenge } = require('../services/android-device-proof');
const { issueRecoveryCode, recoverDevice } = require('../services/android-device-recovery');
const password = z.string().min(1).max(72);
const legacyIdentity = z.object({ mac, password, android_id: z.never().optional() });
const androidIdentity = z.object({ android_id: androidId, type: id }).strict();
const version = z.string().max(60).default('');
const base64 = z.string().min(1).max(160).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const challengeInput = androidIdentity.extend({ public_key: base64, legacy_password: password.optional() });
const androidLogin = androidIdentity.extend({
  version, challenge: z.string().regex(/^[0-9a-f]{64}$/), signature: base64,
});
const recoverInput = androidIdentity.extend({
  public_key: base64,
  code: z.string().max(64).transform(value => value.replace(/[\s-]/g, '').toUpperCase())
    .pipe(z.string().regex(/^[A-F0-9]{20}$/)),
});
const loginInput = z.union([androidIdentity.extend({ version }), androidLogin, legacyIdentity.extend({ type: id, version })]);
const redeemInput = z.union([
  androidIdentity.extend({ id_coupon: id }),
  legacyIdentity.extend({ id_coupon: id, type: id.optional() }),
]);
const listInput = z.object({
  search: z.string().max(100).default(''),
  page: z.union([z.string().regex(/^\d{1,5}$/), z.number().int()]).pipe(z.coerce.number().min(0).max(10000)).default(0),
  used: z.union([z.literal('0'), z.literal('1'), z.literal('3'), z.literal(0), z.literal(1), z.literal(3), z.literal('undefined')]).nullish(),
});
function deviceController(pool) {
  return {
    async challenge(req, res) { res.json(await issueAndroidChallenge(pool, challengeInput.parse(req.body))); },
    async issueRecovery(req, res) { res.json(await issueRecoveryCode(pool, androidLogin.parse(req.body))); },
    async recover(req, res) { res.json(await recoverDevice(pool, recoverInput.parse(req.body))); },
    async login(req, res) { res.json(await service.loginDevice(pool, loginInput.parse(req.body))); },
    async redeem(req, res) { res.json(await service.redeemCoupon(pool, req.user.id, redeemInput.parse(req.body))); },
    async coupons(req, res) {
      const params = listInput.parse(req.method === 'GET' ? req.query : req.body);
      const used = ['0', '1'].includes(String(params.used)) ? Number(params.used) : null;
      res.json(await listCoupons(pool, req.user.id, { ...params, used }));
    },
  };
}
module.exports = { deviceController };

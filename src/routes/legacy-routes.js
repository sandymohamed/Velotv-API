const { Router } = require('express');
const { createRateLimit: rateLimit } = require('../middleware/rate-limit');
const { authenticate } = require('../middleware/auth');
const { login } = require('../controllers/auth-controller');
const { creditController } = require('../controllers/credit-controller');
const { deviceController } = require('../controllers/device-controller');

const { paymentController } = require('../controllers/payment-controller');

function legacyRoutes(pool, key, paypal) {
  const router = Router();
  const rate = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
  const admin = authenticate(pool, key, ['admin']);
  const reseller = authenticate(pool, key, ['reseller']);
  const credits = creditController(pool);
  const device = deviceController(pool);
  router.post('/api/admin/login', rate, login(pool, key, 'admin'));
  router.post(['/reseller/user/login', '/reseller/user/user/login', '/reseller/service/login'], rate, login(pool, key, 'reseller'));
  const deviceRate = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });
  router.post('/api/apps/devices/challenge', deviceRate, device.challenge);
  router.post('/api/apps/devices/login', deviceRate, device.login);
  const recoveryRate = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
  router.post('/api/apps/devices/recovery-code', recoveryRate, device.issueRecovery);
  router.post('/api/apps/devices/recover', recoveryRate, device.recover);
  router.post('/reseller/paybalance/newbalance', admin, credits.manual);
  router.get('/reseller/service/CurrentSolde', reseller, credits.balance);
  router.get('/reseller/service/payment', reseller, credits.history);
  router.get('/api/admin/resellers/:id/credit-report', admin, credits.reconcile);
  router.post('/reseller/coupon', reseller, credits.buy);
  router.get('/reseller/coupon', reseller, device.coupons);
  router.post('/reseller/devices', reseller, device.coupons);
  router.post('/reseller/devices/redeemed', reseller, device.redeem);
  for (const [path, purpose] of [['pay', 'package'], ['paybalance', 'balance']]) {
    const payment = paymentController(pool, paypal, purpose);
    router.post(`/reseller/${path}/paypal/pay`, reseller, rate, payment.create);
    router.get(`/reseller/${path}/paypal/success`, rate, payment.success);
  }
  return router;
}
module.exports = { legacyRoutes };

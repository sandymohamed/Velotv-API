const { checkoutExpectation } = require('../utils/checkout-expectation');
const { paymentEnabled } = require('../services/reseller-access');
const { HttpError } = require('../utils/errors');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { id, money, reference } = require('../utils/validation');
const service = require('../services/credit-service');
const { transaction } = require('../config/database');
const { listPackagePayments } = require('../models/payment-model');
const { listRedemptions } = require('../models/coupon-model');
const { readBalance, readLedger, readPayments } = require('../models/credit-model');

const topUp = z.object({
  reseller_id: id,
  amount: money,
  paymentId: reference,
  paymentEmail: z.email().max(255).optional().or(z.literal('')),
  kind: z.enum(['manual_paid', 'gift']),
  paidAmount: money.optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
}).refine(data => data.kind === 'gift' ? !data.paidAmount && !data.currency : data.paidAmount && data.currency);

function creditController(pool) {
  return {
    async manual(req, res) {
      const data = topUp.parse(req.body);
      if (data.kind === 'manual_paid' && !(await paymentEnabled(pool, 'manual'))) throw new HttpError(503, 'Manual payments are disabled');
      res.json(await service.manualTopUp(pool, req.user.id, {
        ...data, resellerId: data.reseller_id, reference: data.paymentId, email: data.paymentEmail,
      }));
    },
    async buy(req, res) {
      if (!(await paymentEnabled(pool, 'credits'))) throw new HttpError(503, 'Credit purchases are disabled');
      const { package: packageId, offer_id: offerId, expected_terms: expectedTerms } = z.object({ package: id, offer_id: id.optional(), expected_terms: checkoutExpectation.optional() }).parse(req.body);
      const operationId = reference.parse(req.get('Idempotency-Key') ?? randomUUID());
      res.json(await service.buyCoupons(pool, req.user.id, packageId, operationId, offerId, expectedTerms));
    },
    async history(req, res) {
      res.json({ error: false, message: 'success', data: await readLedger(pool, req.user.id) });
    },
    async reconcile(req, res) {
      const resellerId = id.parse(req.params.id);
      const report = await transaction(pool, async db => ({
        resellerId,
        balance: await readBalance(db, resellerId),
        ledger: await readLedger(db, resellerId),
        payments: await readPayments(db, resellerId),
        packagePayments: await listPackagePayments(db, resellerId),
        activations: await listRedemptions(db, resellerId),
      }));
      res.json(report);
    },
    async balance(req, res) {
      const amount = await readBalance(pool, req.user.id);
      res.json({ error: false, message: '', solde: amount });
    },
  };
}
module.exports = { creditController };

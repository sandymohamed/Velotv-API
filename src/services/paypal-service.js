const { randomUUID, randomBytes } = require('node:crypto');
const { transaction } = require('../config/database');
const { HttpError } = require('../utils/errors');
const model = require('../models/payment-model');
const coupons = require('../models/coupon-model');
const credits = require('../models/credit-model');
const { units, decimal } = require('./credit-service');
const packages = require('./package-offer-service');

function verifyCapture(order, remote, merchantId) {
  const purchase = remote.purchase_units?.length === 1 && remote.purchase_units[0];
  const captures = purchase?.payments?.captures;
  const capture = captures?.length === 1 && captures[0];
  if (remote.id !== order.paypal_order_id || remote.status !== 'COMPLETED' ||
      purchase?.custom_id !== order.id || purchase?.payee?.merchant_id !== merchantId ||
      capture?.status !== 'COMPLETED' || !/^[A-Z0-9]{6,64}$/.test(capture.id ?? '') ||
      capture.amount?.currency_code !== order.currency ||
      !/^\d{1,8}(\.\d{1,2})?$/.test(capture.amount?.value ?? '') ||
      Number(capture.amount.value) !== Number(order.amount)) {
    throw new HttpError(409, 'PayPal capture could not be verified');
  }
  return capture.id;
}

function validateOrderPrice(price, terms) {
  if (!/^\d{1,5}(\.\d{1,5})?$/.test(String(price)) ||
      units(price) % 1000n !== 0n || Number(price) <= 0 ||
      (terms && Number(price) >= 1000)) {
    throw new HttpError(400, 'Invalid checkout amount or package');
  }
}

async function createPayment(pool, paypal, resellerId, purpose, input) {
  if (!paypal) throw new HttpError(503, 'PayPal is not configured');
  let order;
  if (purpose === 'package') {
    order = await transaction(pool, async db => {
      await credits.lockBalance(db, resellerId, { requireAccess: true });
      const terms = await packages.quote(db, input.package_id, resellerId, { lock: true, offerId: input.offer_id, expectedTerms: input.expected_terms });
      validateOrderPrice(terms.amount, terms);
      const id = randomUUID();
      const purchaseId = await packages.reservePurchase(db, resellerId, terms, 'paypal', id);
      const intent = {
        id, resellerId, purpose, packageId: terms.package_id,
        duration: terms.periods, couponCount: terms.count_devices,
        amount: Number(terms.amount).toFixed(2), currency: 'EUR', purchaseId,
      };
      await model.createIntent(db, intent);
      return intent;
    });
  } else {
    validateOrderPrice(input.amount);
    order = { id: randomUUID(), resellerId, purpose, packageId: null,
      duration: null, couponCount: null, amount: Number(input.amount).toFixed(2), currency: 'EUR' };
    await model.createIntent(pool, order);
  }
  // Commit the reservation BEFORE contacting PayPal. Pending orders count toward
  // offer limits, including ambiguous network failures. Never release them by a
  // timer: an order may already have been approved or captured remotely.
  const remote = await paypal.create(order);
  await model.attachOrder(pool, order.id, remote.id);
  return { redirectUrl: remote.redirectUrl, purchase_id: order.purchaseId ?? null };
}

async function confirmPayment(pool, paypal, purpose, token) {
  if (!paypal) throw new HttpError(503, 'PayPal is not configured');
  const order = await model.findOrder(pool, token);
  if (!order || order.purpose !== purpose) throw new HttpError(404, 'Payment not found');
  if (order.fulfilled_at) return;
  let remote = await paypal.read(token);
  if (remote.status === 'APPROVED') {
    try { await paypal.capture(token, order.id); }
    catch (error) {
      remote = await paypal.read(token);
      if (remote.status !== 'COMPLETED') throw error;
    }
    remote = await paypal.read(token);
  }
  const captureId = verifyCapture(order, remote, paypal.merchantId);
  await transaction(pool, async db => {
    const current = await model.findOrder(db, token, true);
    if (current.fulfilled_at) return;
    if (purpose === 'balance') {
      const balance = await credits.lockBalance(db, current.reseller_id);
      const old = units(balance.amount);
      const newBalance = decimal(old + units(current.amount));
      await credits.recordPayment(db, {
        reference: captureId, paidAmount: current.amount, amount: current.amount,
        resellerId: current.reseller_id, kind: 'paypal',
      });
      await credits.saveBalance(db, current.reseller_id, balance, decimal(old), newBalance,
        `PAYPAL | ${current.amount} EUR | Capture ${captureId}`);
    } else {
      await credits.lockBalance(db, current.reseller_id);
      await model.recordPackage(db, current, captureId);
      const codes = Array.from({ length: current.coupon_count }, () => randomBytes(12).toString('hex').toUpperCase());
      await coupons.createCoupons(db, current.reseller_id, current.duration, codes, current.purchase_id);
      if (current.purchase_id) await packages.fulfillPurchase(db, current.purchase_id);
    }
    await model.markFulfilled(db, current.id, captureId);
  });
}

module.exports = { createPayment, confirmPayment, verifyCapture };

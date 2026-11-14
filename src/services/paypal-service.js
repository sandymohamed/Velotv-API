const { randomUUID, randomBytes } = require('node:crypto');
const { transaction } = require('../config/database');
const { HttpError } = require('../utils/errors');
const model = require('../models/payment-model');
const coupons = require('../models/coupon-model');
const credits = require('../models/credit-model');
const { units, decimal } = require('./credit-service');

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

async function createPayment(pool, paypal, resellerId, purpose, input) {
  if (!paypal) throw new HttpError(503, 'PayPal is not configured');
  const pack = purpose === 'package' ? await coupons.loadPackage(pool, input.package_id) : null;
  if (purpose === 'package' && !pack) throw new HttpError(404, 'Package not found');
  const price = pack ? pack.package_amount : input.amount;
  if (!/^\d{1,5}(\.\d{1,5})?$/.test(String(price)) ||
      units(price) % 1000n !== 0n || Number(price) <= 0 ||
      (pack && (Number(price) >= 1000 || pack.count_devices < 1 || pack.count_devices > 1000 ||
        pack.periods < 1 || pack.periods > 120))) {
    throw new HttpError(400, 'Invalid checkout amount or package');
  }
  // The legacy routes charge in EUR. Package prices are read from MySQL.
  const order = {
    id: randomUUID(), resellerId, purpose, packageId: pack?.id ?? null,
    duration: pack?.periods ?? null, couponCount: pack?.count_devices ?? null,
    amount: Number(price).toFixed(2), currency: 'EUR',
  };
  await model.createIntent(pool, order);
  const remote = await paypal.create(order);
  await model.attachOrder(pool, order.id, remote.id);
  return { redirectUrl: remote.redirectUrl };
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
      await coupons.createCoupons(db, current.reseller_id, current.duration, codes);
    }
    await model.markFulfilled(db, current.id, captureId);
  });
}

module.exports = { createPayment, confirmPayment, verifyCapture };

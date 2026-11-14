const { createHash, randomBytes } = require('node:crypto');
const { transaction } = require('../config/database');
const { HttpError } = require('../utils/errors');
const credits = require('../models/credit-model');
const coupons = require('../models/coupon-model');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function units(value) {
  if (value == null) return 0n;
  const match = /^(\d{1,5})(?:\.(\d{1,5}))?$/.exec(String(value));
  if (!match) throw new HttpError(409, 'Balance or price needs reconciliation');
  return BigInt(match[1]) * 100000n + BigInt((match[2] ?? '').padEnd(5, '0'));
}
function decimal(amount) {
  if (amount < 0n || amount > 9999999999n) throw new HttpError(409, 'Balance outside supported range');
  return `${amount / 100000n}.${String(amount % 100000n).padStart(5, '0')}`;
}

async function runCreditOperation(pool, input, work) {
  const key = hash(input.operation);
  const requestHash = hash(input.fingerprint);
  return transaction(pool, async db => {
    const balance = await credits.lockBalance(db, input.resellerId);
    const previous = await credits.readOperation(db, key);
    if (previous) {
      if (previous.request_hash !== requestHash) throw new HttpError(409, 'Reference already used with different details');
      return typeof previous.result === 'string' ? JSON.parse(previous.result) : previous.result;
    }
    const result = await work(db, balance);
    await credits.saveOperation(db, { ...input, key, requestHash, result });
    return result;
  }).catch(error => {
    if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
      throw new HttpError(409, 'Concurrent change. Retry with the same reference.');
    }
    throw error;
  });
}

function manualTopUp(pool, actorId, data) {
  const reference = data.reference.toUpperCase();
  return runCreditOperation(pool, {
    resellerId: data.resellerId, actorId, kind: data.kind, reference,
    operation: ['manual-top-up', reference],
    fingerprint: [data.resellerId, data.kind, data.amount, data.paidAmount, data.currency],
  }, async (db, balance) => {
    const old = units(balance.amount);
    const updated = decimal(old + units(data.amount));
    const paymentId = await credits.recordPayment(db, {
      ...data, reference, paidAmount: data.paidAmount ?? '0.00000',
    });
    const detail = data.currency ? ` ${data.paidAmount} ${data.currency}` : '';
    await credits.saveBalance(db, data.resellerId, balance, decimal(old), updated,
      `${data.kind}${detail} | Ref ${reference} | Payment ${paymentId} | Admin ${actorId}`);
    return { error: false, message: 'Payment Verified with success', paymentId, balance: updated };
  });
}

function buyCoupons(pool, resellerId, packageId, reference) {
  return runCreditOperation(pool, {
    resellerId, actorId: resellerId, kind: 'coupon_purchase', reference,
    operation: ['coupon_purchase', resellerId, reference],
    fingerprint: [resellerId, packageId],
  }, async (db, balance) => {
    const pack = await coupons.loadPackage(db, packageId);
    if (!pack) throw new HttpError(404, 'Package not found');
    const price = units(pack.package_amount);
    const previous = units(balance.amount);
    if (price <= 0n || !Number.isInteger(pack.count_devices) || pack.count_devices < 1 ||
        pack.count_devices > 1000 || !Number.isInteger(pack.periods) || pack.periods < 1 || pack.periods > 120) {
      throw new HttpError(409, 'Invalid package configuration');
    }
    if (previous < price) throw new HttpError(400, 'Check if the available balance is sufficient for the transaction');
    const updated = decimal(previous - price);
    const codes = Array.from({ length: pack.count_devices }, () => randomBytes(12).toString('hex').toUpperCase());
    await coupons.createCoupons(db, resellerId, pack.periods, codes);
    await credits.saveBalance(db, resellerId, balance, decimal(previous), updated, `Buy ${codes.length} Coupons | Ref ${reference}`);
    return { error: false, message: 'success', balance: updated };
  });
}

module.exports = { manualTopUp, buyCoupons, units, decimal };

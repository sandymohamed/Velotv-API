const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCapture } = require('../src/services/paypal-service');

test('PayPal verifies the stored order, merchant, currency and completed capture', () => {
  const order = { id: 'local-id', paypal_order_id: 'PAYPAL123', currency: 'EUR', amount: '10.00' };
  const capture = { id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '10.00' } };
  const remote = { id: 'PAYPAL123', status: 'COMPLETED', purchase_units: [{
    custom_id: 'local-id', payee: { merchant_id: 'MERCHANT123' }, payments: { captures: [capture] },
  }] };
  assert.equal(verifyCapture(order, remote, 'MERCHANT123'), 'CAPTURE123');
  assert.throws(() => verifyCapture(order, remote, 'OTHER'), /verified/);
  assert.throws(() => verifyCapture({ ...order, id: 'changed' }, remote, 'MERCHANT123'), /verified/);
  assert.throws(() => verifyCapture({ ...order, amount: '11.00' }, remote, 'MERCHANT123'), /verified/);
  assert.throws(() => verifyCapture({ ...order, currency: 'USD' }, remote, 'MERCHANT123'), /verified/);
  capture.status = 'PENDING';
  assert.throws(() => verifyCapture(order, remote, 'MERCHANT123'), /verified/);
});

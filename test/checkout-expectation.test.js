const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkoutExpectation, assertExpectation } = require('../src/utils/checkout-expectation');

const terms = { amount: '1.000', periods: 1, count_devices: 3, offer_id: 11 };
test('checkout accepts equivalent displayed terms and preserves legacy clients', () => {
  const expected=checkoutExpectation.parse({ amount:'1.00',periods:1,count_devices:3,offer_id:11 });
  assert.doesNotThrow(()=>assertExpectation(terms,expected));
  assert.doesNotThrow(()=>assertExpectation(terms,null));
});
test('checkout rejects changed amount, duration, quantity or offer before fulfillment', () => {
  for(const difference of [{amount:'2.00'},{periods:12},{count_devices:20},{offer_id:null}]) {
    assert.throws(()=>assertExpectation(terms,{...terms,...difference}),error=>error.status===409);
  }
});
test('checkout expectations reject invalid and incomplete activation terms', () => {
  for(const difference of [{amount:0},{periods:0},{count_devices:1001},{offer_id:0}]) {
    assert.equal(checkoutExpectation.safeParse({...terms,...difference}).success,false);
  }
  assert.equal(checkoutExpectation.safeParse({amount:1}).success,false);
});

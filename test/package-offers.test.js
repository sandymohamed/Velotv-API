const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseQuote, priceUnits } = require('../src/services/package-offer-service');
const { offerInput } = require('../src/routes/package-offer-routes');

const pack = { id: 7, package_name: 'Annual 20', package_amount: '15.000', periods: 12,
  count_devices: 20, enabled: 1, offer_only: 0 };
const offer = { id: 3, name: 'Launch', enabled: 1, in_window: 1,
  offer_amount: '12.000', audience: 'all', targeted: 0,
  max_purchases_per_reseller: 1, purchase_count: 0,
  starts_at: '2026-11-18 00:00:00', ends_at: '2027-02-18 00:00:00' };

test('eligible offer preserves the base price and the full purchased entitlement', () => {
  const terms = chooseQuote(pack, [offer]);
  assert.equal(terms.amount, '12.000');
  assert.equal(terms.base_amount, '15.000');
  assert.equal(terms.periods, 12);
  assert.equal(terms.count_devices, 20);
  assert.equal(terms.offer_id, 3);
  assert.equal(terms.currency, 'EUR');
  assert.equal(pack.package_amount, '15.000');
});

test('disabled packages reject base and discounted purchases', () => {
  assert.throws(() => chooseQuote({ ...pack, enabled: 0 }, [offer]), /unavailable/);
});

test('inactive, future, expired, unauthorized and exhausted offers do not discount', () => {
  for (const changes of [{ enabled: 0 }, { in_window: 0 },
    { audience: 'selected', targeted: 0 }, { purchase_count: 1 },
    { purchase_count: 2 }, { offer_amount: '16.000' }]) {
    assert.equal(chooseQuote(pack, [{ ...offer, ...changes }]).offer_id, null);
    assert.throws(() => chooseQuote(pack, [{ ...offer, ...changes }], offer.id), /Offer is unavailable/);
    assert.throws(() => chooseQuote({ ...pack, offer_only: 1 }, [{ ...offer, ...changes }]), /requires an available offer/);
  }
});

test('selected reseller and unlimited purchase offers work', () => {
  assert.equal(chooseQuote(pack, [{ ...offer, audience: 'selected', targeted: 1 }]).offer_id, 3);
  assert.equal(chooseQuote(pack, [{ ...offer, max_purchases_per_reseller: null, purchase_count: 999 }]).offer_id, 3);
});

test('overlapping offers pick the cheapest eligible price deterministically or an explicit offer', () => {
  const offers = [offer, { ...offer, id: 5, offer_amount: '10.000' }, { ...offer, id: 4, offer_amount: '10.000' }];
  assert.equal(chooseQuote(pack, offers).offer_id, 4);
  assert.equal(chooseQuote(pack, offers, 3).offer_id, 3);
  assert.equal(chooseQuote(pack, offers).amount, '10.000');
});

test('offer input requires a valid UTC/offset schedule and an explicit valid audience', () => {
  const input = { name: 'Trial', enabled: true, starts_at: '2026-11-18T00:00:00Z',
    ends_at: '2027-02-18T00:00:00Z', offer_amount: 1,
    max_purchases_per_reseller: 1, audience: 'selected', reseller_ids: [8] };
  assert.equal(offerInput.safeParse(input).success, true);
  for (const changes of [{ ends_at: input.starts_at }, { starts_at: '2026-11-18 00:00:00' },
    { max_purchases_per_reseller: 0 }, { audience: 'selected', reseller_ids: [] },
    { audience: 'all' }, { reseller_ids: [8,8] }, { offer_amount: 0 }, { offer_amount: 1.001 }]) {
    assert.equal(offerInput.safeParse({ ...input, ...changes }).success, false, JSON.stringify(changes));
  }
});

test('prices use exact units without floating point arithmetic', () => {
  assert.equal(priceUnits('0.25'), 25000n);
  assert.equal(priceUnits('12.000'), 1200000n);
  assert.throws(() => priceUnits('-1'));
});

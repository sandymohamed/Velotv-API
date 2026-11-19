const { assertExpectation } = require('../utils/checkout-expectation');
const { randomUUID } = require('node:crypto');
const { HttpError } = require('../utils/errors');

function priceUnits(value) {
  const match = /^(\d{1,5})(?:\.(\d{1,5}))?$/.exec(String(value));
  if (!match) throw new HttpError(409, 'Invalid package price');
  return BigInt(match[1]) * 100000n + BigInt((match[2] || '').padEnd(5, '0'));
}

// Pure policy used by the catalog and authoritative, transaction-locked checkout.
function chooseQuote(pack, offers, requestedOfferId = null) {
  if (!pack || pack.archived_at || !Number(pack.enabled)) throw new HttpError(409, 'Package is unavailable');
  const base = priceUnits(pack.package_amount);
  if (base <= 0n || !Number.isInteger(pack.periods) || pack.periods < 1 || pack.periods > 120 ||
      !Number.isInteger(pack.count_devices) || pack.count_devices < 1 || pack.count_devices > 1000) {
    throw new HttpError(409, 'Invalid package configuration');
  }
  const eligible = offers.filter(offer => Number(offer.enabled) && Number(offer.in_window) &&
    (offer.audience === 'all' || Number(offer.targeted)) &&
    (offer.max_purchases_per_reseller == null || Number(offer.purchase_count) < offer.max_purchases_per_reseller) &&
    priceUnits(offer.offer_amount) > 0n && priceUnits(offer.offer_amount) <= base);
  eligible.sort((a, b) => {
    const aa = priceUnits(a.offer_amount), bb = priceUnits(b.offer_amount);
    return aa === bb ? Number(a.id) - Number(b.id) : aa < bb ? -1 : 1;
  });
  const offer = requestedOfferId != null
    ? eligible.find(item => Number(item.id) === Number(requestedOfferId)) : eligible[0];
  if (requestedOfferId != null && !offer) throw new HttpError(409, 'Offer is unavailable or its purchase limit has been reached');
  if (Number(pack.offer_only) && !offer) throw new HttpError(409, 'This package requires an available offer');
  return {
    package_id: pack.id, package_name: pack.package_name, base_amount: String(pack.package_amount),
    amount: String(offer ? offer.offer_amount : pack.package_amount), currency: 'EUR',
    periods: pack.periods, count_devices: pack.count_devices,
    offer_id: offer?.id ?? null, offer_name: offer?.name ?? null,
    offer_starts_at: offer?.starts_at ?? null, offer_ends_at: offer?.ends_at ?? null,
    max_purchases_per_reseller: offer?.max_purchases_per_reseller ?? null,
    audience: offer?.audience ?? null,
  };
}

async function quote(db, packageId, resellerId, { lock = false, offerId = null, expectedTerms = null } = {}) {
  // All package/offer administration also locks this row, serializing price changes.
  const [[pack]] = await db.execute('SELECT id, package_name, package_amount, periods, count_devices, enabled, offer_only, archived_at FROM packages_reseller WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [packageId]);
  if (!pack) throw new HttpError(404, 'Package not found');
  const [offers] = await db.execute(`SELECT o.*,
    o.starts_at <= UTC_TIMESTAMP() AND UTC_TIMESTAMP() < o.ends_at AS in_window,
    EXISTS(SELECT 1 FROM velotv_package_offer_resellers r WHERE r.offer_id=o.id AND r.reseller_id=?) AS targeted,
    (SELECT COUNT(*) FROM velotv_package_purchases p WHERE p.offer_id=o.id AND p.reseller_id=?
      AND p.status IN ('pending','fulfilled')) AS purchase_count
    FROM velotv_package_offers o WHERE o.package_id=?`, [resellerId, resellerId, packageId]);
  const terms = chooseQuote(pack, offers, offerId);
  assertExpectation(terms, expectedTerms);
  return terms;
}

async function reservePurchase(db, resellerId, terms, channel, reference) {
  const purchaseId = randomUUID();
  await db.execute(`INSERT INTO velotv_package_purchases
    (id,reseller_id,package_id,offer_id,channel,status,reference,base_amount,amount,currency,duration,coupon_count,snapshot)
    VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?)`,
  [purchaseId,resellerId,terms.package_id,terms.offer_id,channel,reference,terms.base_amount,
    terms.amount,terms.currency,terms.periods,terms.count_devices,JSON.stringify({ ...terms, version: 1 })]);
  return purchaseId;
}

async function fulfillPurchase(db, purchaseId) {
  await db.execute("UPDATE velotv_package_purchases SET status='fulfilled', fulfilled_at=UTC_TIMESTAMP() WHERE id=? AND status='pending'", [purchaseId]);
}

async function catalog(db, resellerId) {
  const [packages] = await db.execute('SELECT id FROM packages_reseller WHERE enabled=1 AND archived_at IS NULL ORDER BY package_amount,id');
  const rows = [];
  for (const item of packages) {
    try {
      const terms = await quote(db, item.id, resellerId);
      // Legacy dashboards continue to use package_amount as the amount to charge.
      rows.push({ id: terms.package_id, ...terms, package_amount: terms.amount });
    } catch (error) {
      if (!(error instanceof HttpError) || ![404,409].includes(error.status)) throw error;
    }
  }
  return rows;
}

module.exports = { quote, chooseQuote, reservePurchase, fulfillPurchase, catalog, priceUnits };

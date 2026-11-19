const { transaction } = require('../config/database');
const { HttpError } = require('../utils/errors');

async function lockPackage(db, packageId) {
  const [[pack]] = await db.execute(
    'SELECT id, package_name, created_at, archived_at FROM packages_reseller WHERE id=? FOR UPDATE', [packageId]);
  return pack;
}

async function removalPlan(db, pack) {
  if (pack.archived_at) return { action: 'archived', reason: 'This package is already archived.' };
  // Every current checkout locks the package before reserving or buying. Holding
  // that lock prevents a purchase from being inserted between this check and DELETE.
  const [[history]] = await db.execute(`SELECT
    EXISTS(SELECT 1 FROM velotv_package_purchases WHERE package_id=?) AS purchases,
    EXISTS(SELECT 1 FROM velotv_paypal_orders WHERE package_id=?) AS paypal_orders,
    EXISTS(SELECT 1 FROM payment_reseller WHERE packages=?) AS legacy_payments,
    EXISTS(SELECT 1 FROM reseller_packages WHERE purchase_id IS NULL AND created_at>=?) AS unlinked_coupons,
    EXISTS(SELECT 1 FROM velotv_credit_operations WHERE kind='coupon_purchase' AND created_at>=?
      AND JSON_EXTRACT(result,'$.purchase_id') IS NULL) AS legacy_wallet_operations`,
  [pack.id, pack.id, pack.id, pack.created_at, pack.created_at]);
  if (Number(history.purchases) || Number(history.paypal_orders) || Number(history.legacy_payments)) {
    return { action: 'archived', reason: 'Purchase or payment history exists. The package will be archived and its records kept.' };
  }
  // Older wallet codes were not linked to package IDs. If they could belong to
  // this package, retain its identity rather than claiming it was never used.
  if (Number(history.unlinked_coupons) || Number(history.legacy_wallet_operations)) {
    return { action: 'archived', reason: 'Older activation records may belong to this package. It will be archived to preserve historical references.' };
  }
  return { action: 'deleted', reason: 'No purchase or payment history was found. The package and its unused offers will be permanently deleted.' };
}

async function audit(db, adminId, action, packageId) {
  await db.execute('INSERT INTO velotv_admin_activity(admin_id,action,target_id) VALUES (?,?,?)',
    [adminId, action, packageId]);
}

function previewRemoval(pool, packageId) {
  return transaction(pool, async db => {
    const pack = await lockPackage(db, packageId);
    if (!pack) throw new HttpError(404, 'Package not found');
    return { id: pack.id, package_name: pack.package_name, ...await removalPlan(db, pack) };
  });
}

function removePackage(pool, packageId, adminId) {
  return transaction(pool, async db => {
    const pack = await lockPackage(db, packageId);
    if (!pack) return { id: packageId, action: 'already_deleted', message: 'Package was already removed.' };
    // Recheck at confirmation time, even if the preview said permanent deletion.
    const plan = await removalPlan(db, pack);
    if (plan.action === 'archived') {
      await db.execute(`UPDATE packages_reseller SET enabled=0,
        archived_at=COALESCE(archived_at,UTC_TIMESTAMP()), updated_at=UTC_TIMESTAMP() WHERE id=?`, [packageId]);
      await db.execute('UPDATE velotv_package_offers SET enabled=0,updated_at=UTC_TIMESTAMP() WHERE package_id=?', [packageId]);
      if (!pack.archived_at) await audit(db, adminId, 'coupon_package_archived', packageId);
      return { id: packageId, action: 'archived', message: 'Package archived. Existing activations, codes and purchases are unchanged.' };
    }
    await db.execute(`DELETE r FROM velotv_package_offer_resellers r
      JOIN velotv_package_offers o ON o.id=r.offer_id WHERE o.package_id=?`, [packageId]);
    await db.execute('DELETE FROM velotv_package_offers WHERE package_id=?', [packageId]);
    await db.execute('DELETE FROM packages_reseller WHERE id=?', [packageId]);
    await audit(db, adminId, 'coupon_package_deleted', packageId);
    return { id: packageId, action: 'deleted', message: 'Unused package and its offers permanently deleted.' };
  });
}

function restorePackage(pool, packageId, adminId) {
  return transaction(pool, async db => {
    const pack = await lockPackage(db, packageId);
    if (!pack) throw new HttpError(404, 'Package not found');
    if (!pack.archived_at) return { id: packageId, action: 'already_restored', message: 'Package is not archived.' };
    // Restoring is deliberately separate from enabling sales or old offers.
    await db.execute('UPDATE packages_reseller SET archived_at=NULL,enabled=0,updated_at=UTC_TIMESTAMP() WHERE id=?', [packageId]);
    await audit(db, adminId, 'coupon_package_restored', packageId);
    return { id: packageId, action: 'restored', message: 'Package restored in a disabled state. Review its price and enable it when ready.' };
  });
}

module.exports = { previewRemoval, removePackage, restorePackage, removalPlan };

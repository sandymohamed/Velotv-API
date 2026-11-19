async function loadPackage(db, packageId) {
  const [[row]] = await db.execute('SELECT id, package_amount, periods, count_devices FROM packages_reseller WHERE id = ?', [packageId]);
  return row;
}

async function createCoupons(db, resellerId, duration, codes, purchaseId = null) {
  for (const code of codes) {
    await db.execute('INSERT INTO reseller_packages(id_reseller, duration, coupon, used, purchase_id) VALUES (?, ?, ?, 0, ?)',
      [resellerId, duration, code, purchaseId]);
  }
}

async function lockCoupon(db, resellerId, couponId) {
  const [[row]] = await db.execute(`SELECT id, duration, used FROM reseller_packages
    WHERE id = ? AND id_reseller = ? FOR UPDATE`, [couponId, resellerId]);
  return row;
}

async function redeem(db, resellerId, deviceId, coupon) {
  const [spent] = await db.execute('UPDATE reseller_packages SET used = 1, updated_at = UTC_TIMESTAMP() WHERE id = ? AND used = 0', [coupon.id]);
  if (spent.affectedRows !== 1) return false;
  await db.execute('INSERT INTO reseller_devices(id_reseller, id_device, id_coupon, duration) VALUES (?, ?, ?, ?)',
    [resellerId, deviceId, coupon.id, coupon.duration]);
  await db.execute(`UPDATE devices SET status = 1, startPackage = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP(),
    ExipiredAt = TIMESTAMPADD(MONTH, ?, GREATEST(UTC_TIMESTAMP(),
      COALESCE(STR_TO_DATE(ExipiredAt, '%Y-%m-%d %H:%i:%s'), UTC_TIMESTAMP()))) WHERE id = ?`,
  [coupon.duration, deviceId]);
  return true;
}

async function listCoupons(db, resellerId, { search, used, page }) {
  const filter = `FROM reseller_packages p
    WHERE p.id_reseller = ? AND (? IS NULL OR p.used = ?)
      AND (? = '' OR LOCATE(?, p.coupon) > 0 OR EXISTS (
        SELECT 1 FROM reseller_devices rd JOIN devices d ON d.id = rd.id_device
        WHERE rd.id_coupon = p.id AND (LOCATE(?, d.mac) > 0 OR LOCATE(LOWER(?), d.android_id) > 0)
      ))`;
  const args = [resellerId, used, used, search, search, search, search];
  const [result] = await db.execute(`SELECT p.*,
    (SELECT d.mac FROM reseller_devices rd JOIN devices d ON d.id = rd.id_device
      WHERE rd.id_coupon = p.id ORDER BY rd.id DESC LIMIT 1) AS mac,
    (SELECT d.android_id FROM reseller_devices rd JOIN devices d ON d.id = rd.id_device
      WHERE rd.id_coupon = p.id ORDER BY rd.id DESC LIMIT 1) AS android_id
    ${filter} ORDER BY p.id DESC LIMIT 100 OFFSET ?`, [...args, page * 100]);
  const [[{ count }]] = await db.execute(`SELECT COUNT(*) AS count ${filter}`, args);
  return { error: false, result, count, message: 'success' };
}
async function listRedemptions(db, resellerId) {
  const [rows] = await db.execute(`SELECT id, id_device, id_coupon, duration, created_at
    FROM reseller_devices WHERE id_reseller = ? ORDER BY id DESC LIMIT 100`, [resellerId]);
  return rows;
}
module.exports = { loadPackage, createCoupons, lockCoupon, redeem, listCoupons, listRedemptions };

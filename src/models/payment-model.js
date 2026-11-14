async function createIntent(db, order) {
  await db.execute(`INSERT INTO velotv_paypal_orders
    (id, reseller_id, purpose, package_id, duration, coupon_count, amount, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [order.id, order.resellerId, order.purpose, order.packageId, order.duration,
    order.couponCount, order.amount, order.currency]);
}
async function attachOrder(db, id, orderId) {
  await db.execute('UPDATE velotv_paypal_orders SET paypal_order_id = ? WHERE id = ?', [orderId, id]);
}
async function findOrder(db, orderId, lock = false) {
  const sql = lock
    ? 'SELECT * FROM velotv_paypal_orders WHERE paypal_order_id = ? FOR UPDATE'
    : 'SELECT * FROM velotv_paypal_orders WHERE paypal_order_id = ?';
  const [[row]] = await db.execute(sql, [orderId]);
  return row;
}
async function recordPackage(db, order, captureId) {
  await db.execute(`INSERT INTO payment_reseller
    (paymentID, payment_amount, token, facilitatorAccessToken, payerID, email, packages, reseller_id, status, createdtime)
    VALUES (?, ?, '', '', '', '', ?, ?, 1, UTC_TIMESTAMP())`,
  [captureId, order.amount, order.package_id, order.reseller_id]);
}
async function markFulfilled(db, orderId, captureId) {
  await db.execute('UPDATE velotv_paypal_orders SET capture_id = ?, fulfilled_at = UTC_TIMESTAMP() WHERE id = ?', [captureId, orderId]);
}
async function listPackagePayments(db, resellerId) {
  const [rows] = await db.execute(`SELECT id, paymentID, payment_amount, packages, status, createdtime
    FROM payment_reseller WHERE reseller_id = ? ORDER BY id DESC LIMIT 100`, [resellerId]);
  return rows;
}
module.exports = { createIntent, attachOrder, findOrder, recordPackage, markFulfilled, listPackagePayments };

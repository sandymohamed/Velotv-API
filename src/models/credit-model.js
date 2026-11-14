const { HttpError } = require('../utils/errors');

async function lockBalance(db, resellerId) {
  const [[reseller]] = await db.execute('SELECT id, status FROM resellers WHERE id = ? FOR UPDATE', [resellerId]);
  if (!reseller || reseller.status !== 1) throw new HttpError(404, 'Active reseller not found');
  const [rows] = await db.execute('SELECT id, amount FROM credits WHERE reseller_id = ? FOR UPDATE', [resellerId]);
  if (rows.length > 1) throw new HttpError(409, 'Duplicate balance rows need reconciliation');
  return rows[0] ?? { amount: '0.00000' };
}

async function saveBalance(db, resellerId, balance, oldAmount, amount, message) {
  if (balance.id) {
    await db.execute('UPDATE credits SET amount = ?, updated_at = UTC_TIMESTAMP() WHERE id = ?', [amount, balance.id]);
  } else {
    await db.execute('INSERT INTO credits(reseller_id, amount) VALUES (?, ?)', [resellerId, amount]);
  }
  await db.execute('INSERT INTO credit_logs(reseller_id, oldcredits, newcredits, message) VALUES (?, ?, ?, ?)',
    [resellerId, oldAmount, amount, message]);
}

async function recordPayment(db, data) {
  const [result] = await db.execute(`INSERT INTO payment_services
    (paymentID, payment_amount, credits, reseller_id, email, methode, status)
    VALUES (?, ?, ?, ?, ?, ?, 1)`,
  [data.reference, data.paidAmount, data.amount, String(data.resellerId), data.email ?? '', data.kind.toUpperCase()]);
  return result.insertId;
}

async function readOperation(db, key) {
  const [[operation]] = await db.execute('SELECT request_hash, result FROM velotv_credit_operations WHERE operation_key = ? FOR UPDATE', [key]);
  return operation;
}

async function saveOperation(db, entry) {
  await db.execute(`INSERT INTO velotv_credit_operations
    (operation_key, request_hash, reseller_id, actor_id, kind, reference, result) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [entry.key, entry.requestHash, entry.resellerId, entry.actorId, entry.kind, entry.reference, JSON.stringify(entry.result)]);
}

async function readBalance(db, resellerId) {
  const [rows] = await db.execute('SELECT amount FROM credits WHERE reseller_id = ? LIMIT 2', [resellerId]);
  if (rows.length > 1) throw new HttpError(409, 'Duplicate balance rows need reconciliation');
  return rows[0]?.amount ?? '0.00000';
}
async function readLedger(db, resellerId) {
  const [rows] = await db.execute(`SELECT id, reseller_id, oldcredits, newcredits, message, created_at, updated_at
    FROM credit_logs WHERE reseller_id = ? ORDER BY id DESC LIMIT 100`, [resellerId]);
  return rows;
}

async function readPayments(db, resellerId) {
  const [rows] = await db.execute(`SELECT id, paymentID, payment_amount, credits, methode, status, created_at
    FROM payment_services WHERE reseller_id = ? ORDER BY id DESC LIMIT 100`, [String(resellerId)]);
  return rows;
}
module.exports = { lockBalance, saveBalance, recordPayment, readOperation, saveOperation, readBalance, readLedger, readPayments };

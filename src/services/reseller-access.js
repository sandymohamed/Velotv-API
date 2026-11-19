async function activeReseller(db, id, lock = false) {
  const [[account]] = await db.execute(
    'SELECT id, status, onboarding_pending FROM resellers WHERE id = ?' + (lock ? ' FOR UPDATE' : ''), [id]);
  if (account?.status !== 1 || Number(account?.onboarding_pending)) return false;
  const [[membership]] = await db.execute(`SELECT paused_at IS NULL AND archived_at IS NULL
    AND expires_at > UTC_TIMESTAMP() AND starts_at <= UTC_TIMESTAMP() AS permitted
    FROM velotv_reseller_memberships WHERE reseller_id = ?` + (lock ? ' FOR UPDATE' : ''), [id]);
  return !membership || Boolean(membership.permitted);
}

async function paymentEnabled(db, method) {
  const [[setting]] = await db.execute(
    'SELECT enabled FROM velotv_checkout_settings WHERE method = ?', [method]);
  return setting ? Boolean(setting.enabled) : true;
}

module.exports = { activeReseller, paymentEnabled };

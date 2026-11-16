async function findDevice(db, mac, type, lock = false) {
  const sql = lock
    ? 'SELECT * FROM devices WHERE mac = ? ORDER BY id LIMIT 2 FOR UPDATE'
    : 'SELECT * FROM devices WHERE mac = ? AND type = ? ORDER BY id LIMIT 2';
  const [rows] = await db.execute(sql, lock ? [mac] : [mac, type]);
  return rows.length === 1 ? rows[0] : null;
}

async function findAndroidDevice(db, androidId, type, lock = false) {
  const sql = lock
    ? 'SELECT * FROM devices WHERE android_id = ? AND type = ? FOR UPDATE'
    : 'SELECT * FROM devices WHERE android_id = ? AND type = ?';
  const [[device]] = await db.execute(sql, [androidId, type]);
  return device;
}

async function ensureAndroidDevice(db, androidId, type) {
  await db.execute(`INSERT INTO devices (android_id, type, mac, password, status)
    VALUES (?, ?, NULL, '', 0) ON DUPLICATE KEY UPDATE id = id`, [androidId, type]);
}

async function listProfiles(db, deviceId, websiteOnly = false) {
  const [rows] = await db.execute(`SELECT id, profile_name, xml_epg, username, password, host, isXS, source_format, created_at, updated_at
    FROM profiles WHERE id_device = ?
    ${websiteOnly ? 'AND website_managed = 1' : ''} ORDER BY id`, [String(deviceId)]);
  return rows;
}
function isActiveDevice(device) {
  const expiry = device.ExipiredAt;
  const normalized = expiry?.replace(' ', 'T');
  const expiryMs = normalized && Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(normalized) ? normalized : normalized + 'Z');
  return device.status === 1 && expiryMs > Date.now();
}

module.exports = { ensureAndroidDevice, isActiveDevice, findDevice, findAndroidDevice, listProfiles };

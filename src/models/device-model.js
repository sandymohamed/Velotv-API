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

async function listProfiles(db, deviceId) {
  const [rows] = await db.execute(`SELECT id, profile_name, xml_epg, username, password, host, isXS, created_at, updated_at
    FROM profiles WHERE id_device = ? ORDER BY id`, [String(deviceId)]);
  return rows;
}
module.exports = { findDevice, findAndroidDevice, listProfiles };

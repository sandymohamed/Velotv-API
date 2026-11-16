async function findPublicDevice(db, androidId) {
  const [devices] = await db.execute('SELECT id FROM devices WHERE android_id = ? ORDER BY id LIMIT 2 FOR UPDATE', [androidId]);
  return devices;
}

async function resellerDevice(db, deviceId, resellerId) {
  const [[device]] = await db.execute('SELECT id FROM devices WHERE id = ? FOR UPDATE', [deviceId]);
  if (!device) return false;
  const [[owner]] = await db.execute(
    'SELECT id_reseller FROM reseller_devices WHERE id_device = ? ORDER BY id DESC LIMIT 1', [deviceId]);
  return Number(owner?.id_reseller) === resellerId;
}

async function addPlaylist(db, deviceId, input, resellerId = null) {
  const [result] = await db.execute(
    `INSERT INTO profiles (id_device, profile_name, source_format, host, username, password, isXS, added_by_reseller_id, website_managed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(deviceId), input.name, input.format, input.url, input.username ?? '', input.password ?? '',
      input.format === 'xtream' ? '1' : '0', resellerId, resellerId === null]);
  return result.insertId;
}

async function updatePlaylist(db, deviceId, profileId, input) {
  // Keep creator attribution. An edited pre-existing playlist remains historically unassigned.
  const [result] = await db.execute(`UPDATE profiles SET profile_name = ?, source_format = ?, host = ?,
    username = ?, password = ?, isXS = ?, updated_at = UTC_TIMESTAMP()
    WHERE id_device = ? AND id = ?`,
  [input.name, input.format, input.url, input.username ?? '', input.password ?? '',
    input.format === 'xtream' ? '1' : '0', String(deviceId), profileId]);
  return result.affectedRows > 0;
}

async function deletePlaylists(db, deviceId, profileId) {
  const scope = 'p.id_device = ?' + (profileId === undefined ? '' : ' AND p.id = ?');
  const params = profileId === undefined ? [String(deviceId)] : [String(deviceId), profileId];
  await db.execute(`DELETE f FROM favorites f INNER JOIN profiles p ON p.id = f.profileid WHERE ${scope}`, params);
  await db.execute(`DELETE r FROM recent r INNER JOIN profiles p ON p.id = r.profileid WHERE ${scope}`, params);
  await db.execute(`DELETE s FROM secured_categories s INNER JOIN profiles p ON p.id = s.profile_id WHERE ${scope}`, params);
  const [result] = await db.execute(`DELETE p FROM profiles p WHERE ${scope}`, params);
  return result.affectedRows;
}

module.exports = { findPublicDevice, resellerDevice, addPlaylist, updatePlaylist, deletePlaylists };

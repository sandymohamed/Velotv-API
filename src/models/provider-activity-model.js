async function ownsProfile(db, deviceId, profileId, websiteOnly = false) {
  const [[profile]] = await db.execute('SELECT id FROM profiles WHERE id = ? AND id_device = ?' +
    (websiteOnly ? ' AND website_managed = 1' : ''),
    [profileId, String(deviceId)]);
  return Boolean(profile);
}

async function setFavorite(db, { profileid, type, streamid, enabled }) {
  const args = [profileid, type, streamid];
  if (!enabled) {
    await db.execute('DELETE FROM favorites WHERE profileid = ? AND type = ? AND streamid = ?', args);
    return;
  }
  const [[existing]] = await db.execute(
    'SELECT id FROM favorites WHERE profileid = ? AND type = ? AND streamid = ? LIMIT 1', args);
  if (!existing) await db.execute('INSERT INTO favorites (profileid, type, streamid) VALUES (?, ?, ?)', args);
}

async function recordRecent(db, { profileid, type, streamid }) {
  // Preserve any legacy watch position attached to this row.
  const args = [profileid, type, streamid];
  const [[existing]] = await db.execute(
    'SELECT id FROM recent WHERE profileid = ? AND type = ? AND streamid = ? ORDER BY updated_at DESC, id DESC LIMIT 1', args);
  if (existing) {
    await db.execute('UPDATE recent SET updated_at = UTC_TIMESTAMP() WHERE id = ?', [existing.id]);
  } else {
    await db.execute('INSERT INTO recent (profileid, type, streamid) VALUES (?, ?, ?)', args);
  }
}

async function listFavorites(db, { profileid, type }) {
  const [rows] = await db.execute(`SELECT streamid FROM favorites WHERE profileid = ? AND type = ?
    AND streamid IS NOT NULL GROUP BY streamid ORDER BY MAX(id) DESC`, [profileid, type]);
  return rows;
}

async function listRecents(db, { profileid }) {
  const readType = async type => {
    const [rows] = await db.execute(`SELECT streamid FROM recent WHERE profileid = ? AND type = ?
      GROUP BY streamid ORDER BY MAX(updated_at) DESC, MAX(id) DESC LIMIT 100`, [profileid, type]);
    return rows;
  };
  const [live, movie, serie] = await Promise.all(['live', 'movie', 'serie'].map(readType));
  return { live, movie, serie };
}

module.exports = { ownsProfile, setFavorite, recordRecent, listFavorites, listRecents };

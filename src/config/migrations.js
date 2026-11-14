const { createHash } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const directory = join(__dirname, '../../migrations');
const bootstrapFile = '001_legacy_schema.sql';
const originalBootstrapChecksum = '822684b4683e3262f03dfa32ef4f13648e742b10bd6ca403e4d6adcff3c35c94';
const hash = text => createHash('sha256').update(text).digest('hex');

async function migrate(pool) {
  const db = await pool.getConnection();
  let lock;
  try {
    const [[{ name }]] = await db.execute('SELECT DATABASE() AS name');
    const key = 'velo_legacy_' + hash(name).slice(0, 32);
    const [[{ acquired }]] = await db.execute('SELECT GET_LOCK(?, 30) AS acquired', [key]);
    if (acquired !== 1) throw new Error('Migration lock unavailable');
    lock = key;
    await db.query(`CREATE TABLE IF NOT EXISTS velotv_schema_migrations (
      filename VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied BOOLEAN NOT NULL DEFAULT FALSE
    ) ENGINE=InnoDB`);
    const files = (await readdir(directory)).filter(file => /^\d{3}_[a-z_]+\.sql$/.test(file)).sort();
    const [history] = await db.execute('SELECT * FROM velotv_schema_migrations ORDER BY filename');
    // The original bootstrap can fail before creating its first table on MySQL
    // servers that require a primary key. Retry only the known empty failure.
    if (history.length === 1 && history[0].filename === bootstrapFile &&
        history[0].checksum === originalBootstrapChecksum && !history[0].applied &&
        !(await hasApplicationTables(db))) {
      await db.execute('DELETE FROM velotv_schema_migrations WHERE filename = ? AND applied = FALSE', [bootstrapFile]);
      history.pop();
    }
    if (history.some((row, i) => row.filename !== files[i] || !row.applied)) {
      throw new Error('Incomplete or unknown migration history. Inspect the database before retrying.');
    }
    for (const [index, file] of files.entries()) {
      const text = (await readFile(join(directory, file), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = hash(text);
      if (history[index]) {
        const appliedOriginalBootstrap = file === bootstrapFile && history[index].checksum === originalBootstrapChecksum;
        if (history[index].checksum !== checksum && !appliedOriginalBootstrap) {
          throw new Error('Migration checksum mismatch: ' + file);
        }
        continue;
      }
      if (index === 0) {
        if (await hasApplicationTables(db)) throw new Error('Legacy bootstrap requires an empty database');
      }
      await db.execute('INSERT INTO velotv_schema_migrations(filename, checksum) VALUES (?, ?)', [file, checksum]);
      // Migration files are trusted local DDL. Current files contain no semicolons inside values.
      for (const statement of text.replace(/^--[^\n]*$/gm, '').split(';')) {
        if (statement.trim()) await db.query(statement);
      }
      await db.execute('UPDATE velotv_schema_migrations SET applied = TRUE WHERE filename = ?', [file]);
    }
  } finally {
    try { if (lock) await db.execute('SELECT RELEASE_LOCK(?)', [lock]); }
    catch { db.destroy(); }
    finally { db.release(); }
  }
}

async function hasApplicationTables(db) {
  const [tables] = await db.execute(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_name <> 'velotv_schema_migrations' LIMIT 1`);
  return tables.length > 0;
}

module.exports = { migrate };

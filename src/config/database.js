const mysql = require('mysql2/promise');
const { readFileSync } = require('node:fs');

async function connectDatabase(env = process.env) {
  const url = new URL(env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !url.username || !url.hostname || !/^[a-z][a-z0-9_]{0,63}$/.test(database)) {
    throw new Error('DATABASE_URL must be a MySQL URI with a valid database name');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const sslDisabled = env.DB_SSL === 'disable';
  if (sslDisabled && (!local || env.NODE_ENV === 'production')) throw new Error('Plaintext MySQL is local development only');
  const caPem = env.DB_CA_PEM?.replace(/\\n/g, '\n').trim();

  const options = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    port: Number(url.port || 3306), multipleStatements: false, timezone: 'Z',
    charset: 'utf8mb4', connectTimeout: 8000,
    ssl: sslDisabled
      ? undefined
      : {
        rejectUnauthorized: true,
        verifyIdentity: true,
        minVersion: 'TLSv1.2',
        ...(caPem ? { ca: caPem } : {}),
      },
  };
  if (env.DB_AUTO_CREATE === 'true') {
    const conn = await mysql.createConnection(options);
    try {
      await conn.query(`CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(database)} CHARACTER SET utf8mb4`);
    } finally { await conn.end(); }
  }
  return mysql.createPool({ ...options, database, connectionLimit: 10, queueLimit: 100 });
}

async function transaction(pool, work) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const result = await work(db);
    await db.commit();
    return result;
  } catch (error) {
    try { await db.rollback(); } catch { db.destroy(); }
    throw error;
  } finally { db.release(); }
}

module.exports = { connectDatabase, transaction };

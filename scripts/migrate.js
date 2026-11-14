const { connectDatabase } = require('../src/config/database');
const { migrate } = require('../src/config/migrations');

(async () => {
  const pool = await connectDatabase();
  try { await migrate(pool); }
  finally { await pool.end(); }
})().catch(error => {
  console.error('Migration failed:', error.code || error.message);
  process.exitCode = 1;
});

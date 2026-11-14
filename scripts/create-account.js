const { z } = require('zod');
const bcrypt = require('bcryptjs');
const { connectDatabase, transaction } = require('../src/config/database');
const { findLogin } = require('../src/models/account-model');

const input = z.object({
  role: z.enum(['admin', 'reseller']),
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().min(14).refine(value => Buffer.byteLength(value, 'utf8') <= 72),
});

(async () => {
  const data = input.parse({
    role: process.env.ACCOUNT_ROLE, name: process.env.ACCOUNT_NAME,
    email: process.env.ACCOUNT_EMAIL, password: process.env.ACCOUNT_PASSWORD,
  });
  const pool = await connectDatabase();
  try {
    const passwordHash = await bcrypt.hash(data.password, 12);
    await transaction(pool, async db => {
      if (await findLogin(db, data.role, data.email)) throw new Error('Account already exists');
      if (data.role === 'admin') {
        await db.execute('INSERT INTO admins(name, password, email, status) VALUES (?, ?, ?, 1)',
          [data.name, passwordHash, data.email]);
      } else {
        await db.execute("INSERT INTO resellers(username, email, password, phone, status) VALUES (?, ?, ?, '', 1)",
          [data.name, data.email, passwordHash]);
      }
    });
    console.log('Account created.');
  } finally { await pool.end(); }
})().catch(error => {
  console.error('Account creation failed:', error.code || error.name);
  process.exitCode = 1;
});

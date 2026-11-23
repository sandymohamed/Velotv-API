const { Router } = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');
const { authenticate } = require('../middleware/auth');
const { HttpError } = require('../utils/errors');
const { id } = require('../utils/validation');

const accountTables = {
  admin: { table: 'admins', activity: false },
  agent: { table: 'velotv_agents', activity: true },
  reseller: { table: 'resellers', activity: true },
};
const newPassword = z.string().min(10).refine(value => Buffer.byteLength(value) <= 72);
const changeInput = z.object({ current_password: z.string().min(1).max(72), new_password: newPassword }).strict();

function passwordRoutes(pool, key) {
  const router = Router();
  const admin = authenticate(pool, key, ['admin']);
  const agent = authenticate(pool, key, ['agent']);
  const reseller = authenticate(pool, key, ['reseller']);

  async function changeOwnPassword(role, req, res) {
    const input = changeInput.parse(req.body);
    const table = accountTables[role].table;
    const [[account]] = await pool.execute(`SELECT password FROM ${table} WHERE id = ?`, [req.user.id]);
    if (!account || !(await bcrypt.compare(input.current_password, account.password))) {
      throw new HttpError(400, 'Current password is incorrect.');
    }
    if (await bcrypt.compare(input.new_password, account.password)) {
      throw new HttpError(400, 'Choose a password you have not used before.');
    }
    const hash = await bcrypt.hash(input.new_password, 12);
    await pool.execute(`UPDATE ${table} SET password = ?, must_change_password = FALSE, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [hash, req.user.id]);
    res.json({ success: true });
  }

  router.post('/api/admin/console/password', admin, (req, res) => changeOwnPassword('admin', req, res));
  router.post('/api/agent/password', agent, (req, res) => changeOwnPassword('agent', req, res));
  router.post('/reseller/dashboard/password', reseller, (req, res) => changeOwnPassword('reseller', req, res));

  router.post('/api/admin/console/accounts/:role/:id/temporary-password', admin, async (req, res) => {
    const role = z.enum(['agent', 'reseller']).parse(req.params.role);
    const targetId = id.parse(req.params.id);
    const { table } = accountTables[role];
    const [[target]] = await pool.execute(`SELECT id FROM ${table} WHERE id = ?`, [targetId]);
    if (!target) throw new HttpError(404, 'Account not found.');

    const temporaryPassword = randomBytes(15).toString('base64url');
    const hash = await bcrypt.hash(temporaryPassword, 12);
    await pool.execute(`UPDATE ${table} SET password = ?, must_change_password = TRUE, updated_at = UTC_TIMESTAMP() WHERE id = ?`, [hash, targetId]);
    await pool.execute('INSERT INTO velotv_admin_activity(admin_id, action, target_id) VALUES (?,?,?)',
      [req.user.id, `${role}_temporary_password_set`, targetId]);
    res.json({ success: true, temporary_password: temporaryPassword });
  });
  return router;
}

module.exports = { passwordRoutes };

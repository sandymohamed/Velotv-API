const { previewRemoval, removePackage, restorePackage } = require('../services/package-lifecycle-service');
const { Router } = require('express');
const { z } = require('zod');
const bcrypt = require('bcryptjs');
const { authenticate } = require('../middleware/auth');
const { transaction } = require('../config/database');
const { HttpError } = require('../utils/errors');
const { id } = require('../utils/validation');

const label = z.string().trim().min(1).max(120);
const password = z.string().min(10).refine(value => Buffer.byteLength(value) <= 72);
const planInput = z.object({
  name: label, duration_months: z.number().int().min(1).max(120),
  price: z.number().min(0).max(99999999.99).multipleOf(0.01),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  enabled: z.boolean(),
}).strict();
const accountInput = z.object({
  username: z.string().trim().min(2).max(120),
  email: z.email().max(255).toLowerCase(),
  phone: z.string().trim().max(50),
  password,
}).strict();
const listInput = z.object({
  search: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(0).max(10000).default(0),
});
const couponPackage = z.object({
  package_name: label, package_amount: z.number().positive().max(99999.999).multipleOf(0.001),
  periods: z.number().int().min(1).max(120), count_devices: z.number().int().min(1).max(1000),
  enabled: z.boolean().optional(), offer_only: z.boolean().optional(),
}).strict();

const resellerState = `CASE WHEN r.archived_at IS NOT NULL OR m.archived_at IS NOT NULL THEN 'archived'
  WHEN r.status <> 1 OR m.paused_at IS NOT NULL THEN 'paused'
  WHEN r.onboarding_pending=1 THEN 'invitation pending'
  WHEN m.expires_at <= UTC_TIMESTAMP() THEN 'expired'
  WHEN m.plan_id IS NULL THEN 'legacy' ELSE 'active' END`;
const ownership = 'SELECT id_device, MAX(id) AS last_id FROM reseller_devices GROUP BY id_device';

async function record(db, actor, action, target = null) {
  await db.execute('INSERT INTO velotv_admin_activity(admin_id, action, target_id) VALUES (?,?,?)',
    [actor, action, target]);
}

async function assign(db, resellerId, planId) {
  const [[plan]] = await db.execute('SELECT duration_months FROM velotv_reseller_plans WHERE id = ? AND enabled = 1 FOR UPDATE', [planId]);
  if (!plan) throw new HttpError(409, 'Choose an available reseller plan.');
  await db.execute(`INSERT INTO velotv_reseller_memberships (reseller_id, plan_id, starts_at, expires_at)
    VALUES (?, ?, UTC_TIMESTAMP(), TIMESTAMPADD(MONTH, ?, UTC_TIMESTAMP()))
    ON DUPLICATE KEY UPDATE plan_id = ?, starts_at = UTC_TIMESTAMP(),
    expires_at = TIMESTAMPADD(MONTH, ?, UTC_TIMESTAMP()), paused_at = NULL, archived_at = NULL`,
  [resellerId, planId, plan.duration_months, planId, plan.duration_months]);
  await db.execute('UPDATE resellers SET status = 1, archived_at = NULL, updated_at = UTC_TIMESTAMP() WHERE id = ?', [resellerId]);
}

async function listResellers(pool, filters) {
  const from = `FROM resellers r LEFT JOIN velotv_reseller_memberships m ON m.reseller_id = r.id
    WHERE LOCATE(LOWER(?), LOWER(CONCAT_WS(' ',r.username,r.email,r.phone))) > 0 OR ? = ''`;
  const args = [filters.search, filters.search];
  const [rows] = await pool.execute(`SELECT r.id, r.username, r.email, r.phone, r.agent_id,r.onboarding_pending,
    (SELECT username FROM velotv_agents WHERE id=r.agent_id) AS agent_name, m.plan_id,
    m.starts_at, m.expires_at, ${resellerState} AS state,
    (SELECT COUNT(*) FROM profiles p WHERE p.added_by_reseller_id = r.id) AS playlists
    ${from} ORDER BY r.id DESC LIMIT 50 OFFSET ?`, [...args, filters.page * 50]);
  const [[{ count }]] = await pool.execute(`SELECT COUNT(*) AS count ${from}`, args);
  if (!rows.length) return { rows, count };
  const [usage] = await pool.execute(`SELECT rd.id_reseller, COUNT(DISTINCT d.id) AS devices,
    COUNT(DISTINCT u.id) AS users FROM (${ownership}) latest
    JOIN reseller_devices rd ON rd.id = latest.last_id JOIN devices d ON d.id = latest.id_device
    LEFT JOIN user_devices ud ON ud.id_device = d.id LEFT JOIN users u ON u.id = ud.id_user
    WHERE rd.id_reseller IN (${rows.map(() => '?').join(',')}) GROUP BY rd.id_reseller`, rows.map(row => row.id));
  const stats = new Map(usage.map(item => [item.id_reseller, item]));
  return { count, rows: rows.map(row => ({
    ...row, devices: stats.get(row.id)?.devices ?? 0, users: stats.get(row.id)?.users ?? 0,
  })) };
}

async function overview(pool) {
  const [[totals], [months], [activity]] = await Promise.all([
    pool.execute(`SELECT (SELECT COUNT(*) FROM devices) AS devices,
      (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM resellers) AS resellers,
      (SELECT COUNT(*) FROM resellers r LEFT JOIN velotv_reseller_memberships m ON m.reseller_id = r.id
        WHERE (${resellerState}) IN ('active','legacy')) AS active_resellers,
      (SELECT COUNT(*) FROM velotv_standalone_trials) AS trials`),
    pool.execute(`SELECT month, SUM(devices) AS devices, SUM(trials) AS trials, SUM(users) AS users
      FROM (
        SELECT DATE_FORMAT(created_at,'%Y-%m') AS month, COUNT(*) AS devices, 0 AS trials, 0 AS users
        FROM devices WHERE created_at >= DATE_FORMAT(UTC_DATE() - INTERVAL 12 MONTH, '%Y-%m-01') GROUP BY month
        UNION ALL
        SELECT DATE_FORMAT(started_at,'%Y-%m'), 0, COUNT(*), 0
        FROM velotv_standalone_trials WHERE started_at >= DATE_FORMAT(UTC_DATE() - INTERVAL 12 MONTH, '%Y-%m-01') GROUP BY 1
        UNION ALL
        SELECT DATE_FORMAT(created_at,'%Y-%m'), 0, 0, COUNT(*)
        FROM users WHERE created_at >= DATE_FORMAT(UTC_DATE() - INTERVAL 12 MONTH, '%Y-%m-01') GROUP BY 1
      ) m GROUP BY month ORDER BY month`),
    pool.execute('SELECT id, admin_id, action, target_id, created_at FROM velotv_admin_activity ORDER BY id DESC LIMIT 20'),
  ]);
  const data = new Map(months.map(row => [row.month, row]));
  const now = new Date();
  const series = Array.from({length: 13}, (_, i) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12 + i, 1)).toISOString().slice(0, 7);
    return { month, devices: Number(data.get(month)?.devices ?? 0), trials: Number(data.get(month)?.trials ?? 0),
      users: Number(data.get(month)?.users ?? 0) };
  });
  return { totals: totals[0], activity, months: series.slice(1).map((row, index) => {
    const prior = series[index].devices;
    return { ...row, growth: prior ? Math.round(((row.devices - prior) / prior) * 1000) / 10 : null };
  }) };
}

function adminRoutes(pool, key, paypal) {
  const router = Router();
  router.use('/api/admin/console', authenticate(pool, key, ['admin']));
  router.get('/api/admin/console/overview', async (_req, res) => res.json(await overview(pool)));
  router.get('/api/admin/console/devices', async (req, res) => {
    const { search, page } = listInput.parse(req.query);
    const filter = `WHERE ? = '' OR LOCATE(LOWER(?), LOWER(COALESCE(d.android_id,d.mac,''))) > 0`;
    const [rows] = await pool.execute(`SELECT d.id,d.android_id,d.mac,d.type,d.ExipiredAt AS expires_at,
      d.status,d.created_at,r.username AS reseller,
      CASE WHEN d.status = 1 AND STR_TO_DATE(d.ExipiredAt,'%Y-%m-%d %H:%i:%s') > UTC_TIMESTAMP()
        THEN 'active'
        WHEN d.ExipiredAt IS NOT NULL THEN 'expired' ELSE 'registered' END AS state
      FROM devices d LEFT JOIN (${ownership}) latest ON latest.id_device=d.id
      LEFT JOIN reseller_devices rd ON rd.id=latest.last_id LEFT JOIN resellers r ON r.id=rd.id_reseller
      ${filter} ORDER BY d.id DESC LIMIT 50 OFFSET ?`, [search,search,page * 50]);
    const [[{ count }]] = await pool.execute(`SELECT COUNT(*) AS count FROM devices d ${filter}`, [search,search]);
    res.json({ rows, count });
  });
  router.get('/api/admin/console/resellers', async (req, res) => res.json(await listResellers(pool, listInput.parse(req.query))));

  router.post('/api/admin/console/resellers', async (req, res) => {
    const input = accountInput.extend({ plan_id: id }).parse(req.body);
    const hash = await bcrypt.hash(input.password, 12);
    const resellerId = await transaction(pool, async db => {
      await db.execute('SELECT id FROM velotv_staff_creation_lock WHERE id=1 FOR UPDATE');
      await assertAvailableIdentity(db, input);
      const [insert] = await db.execute('INSERT INTO resellers(username,email,phone,password) VALUES (?,?,?,?)',
        [input.username, input.email, input.phone, hash]);
      await assign(db, insert.insertId, input.plan_id);
      await record(db, req.user.id, 'reseller_created', insert.insertId);
      return insert.insertId;
    });
    res.status(201).json({ id: resellerId });
  });

  router.patch('/api/admin/console/resellers/:id', async (req, res) => {
    const resellerId = id.parse(req.params.id);
    const input = accountInput.extend({ password: password.optional() }).parse(req.body);
    const hash = input.password ? await bcrypt.hash(input.password, 12) : null;
    await transaction(pool, async db => {
      await db.execute('SELECT id FROM velotv_staff_creation_lock WHERE id=1 FOR UPDATE');
      await requireReseller(db, resellerId);
      await assertAvailableIdentity(db, input, resellerId);
      await db.execute(`UPDATE resellers SET username=?, email=?, phone=?, password=COALESCE(?,password),
        updated_at=UTC_TIMESTAMP() WHERE id=?`, [input.username, input.email, input.phone, hash, resellerId]);
      await record(db, req.user.id, 'reseller_updated', resellerId);
    });
    res.json({ id: resellerId });
  });

  router.post('/api/admin/console/resellers/:id/membership', async (req, res) => {
    const resellerId = id.parse(req.params.id);
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('assign'), plan_id: id }).strict(),
      z.object({ action: z.enum(['pause','resume','archive']) }).strict(),
    ]).parse(req.body);
    await transaction(pool, async db => {
      await requireReseller(db, resellerId);
      const [[membership]] = await db.execute('SELECT * FROM velotv_reseller_memberships WHERE reseller_id = ? FOR UPDATE', [resellerId]);
      if (input.action === 'assign') {
        await assign(db, resellerId, input.plan_id);
      } else {
        if (input.action === 'resume') {
          if (membership?.expires_at <= new Date()) throw new HttpError(409, 'Assign a new plan to restore expired access.');
          await db.execute('UPDATE velotv_reseller_memberships SET paused_at=NULL, archived_at=NULL WHERE reseller_id=?', [resellerId]);
        } else if (input.action === 'archive') {
          await db.execute('UPDATE velotv_reseller_memberships SET archived_at=UTC_TIMESTAMP() WHERE reseller_id=?', [resellerId]);
        } else {
          await db.execute('UPDATE velotv_reseller_memberships SET paused_at=UTC_TIMESTAMP() WHERE reseller_id=?', [resellerId]);
        }
        await db.execute("UPDATE resellers SET status=?, archived_at=CASE WHEN ? = 'archive' THEN UTC_TIMESTAMP() WHEN ? = 'resume' THEN NULL ELSE archived_at END, updated_at=UTC_TIMESTAMP() WHERE id=?", [input.action === 'resume' ? 1 : 0, input.action, input.action, resellerId]);
      }
      await record(db, req.user.id, 'membership_' + input.action, resellerId);
    });
    res.json({ id: resellerId });
  });

  router.get('/api/admin/console/plans', async (_req, res) => {
    const [plans] = await pool.execute('SELECT * FROM velotv_reseller_plans ORDER BY enabled DESC, name, id');
    res.json({ plans });
  });
  router.post('/api/admin/console/plans', async (req, res) => {
    const input = planInput.parse(req.body);
    const planId = await transaction(pool, async db => {
      const [insert] = await db.execute('INSERT INTO velotv_reseller_plans(name,duration_months,price,currency,enabled) VALUES (?,?,?,?,?)',
        [input.name, input.duration_months, input.price, input.currency, input.enabled]);
      await record(db, req.user.id, 'plan_created', insert.insertId);
      return insert.insertId;
    });
    res.status(201).json({ id: planId });
  });
  router.patch('/api/admin/console/plans/:id', async (req, res) => {
    const planId = id.parse(req.params.id);
    const input = planInput.parse(req.body);
    await transaction(pool, async db => {
      const [updated] = await db.execute('UPDATE velotv_reseller_plans SET name=?,duration_months=?,price=?,currency=?,enabled=? WHERE id=?',
        [input.name, input.duration_months, input.price, input.currency, input.enabled, planId]);
      if (!updated.affectedRows) throw new HttpError(404, 'Plan not found.');
      await record(db, req.user.id, 'plan_updated', planId);
    });
    res.json({ id: planId });
  });

  router.get('/api/admin/console/coupon-packages', async (req, res) => {
    const state = z.enum(['active','archived','all']).default('active').parse(req.query.state);
    const where = state === 'active' ? 'WHERE archived_at IS NULL' : state === 'archived' ? 'WHERE archived_at IS NOT NULL' : '';
    const [packages] = await pool.execute(`SELECT id, package_name, package_amount, periods, count_devices, enabled, offer_only, archived_at
      FROM packages_reseller ${where} ORDER BY id DESC`);
    res.json({ packages });
  });
  router.post('/api/admin/console/coupon-packages', async (req, res) => {
    const input = couponPackage.parse(req.body);
    const packageId = await transaction(pool, async db => {
      const [insert] = await db.execute('INSERT INTO packages_reseller(package_name,package_amount,periods,count_devices,id_pay,enabled,offer_only) VALUES (?,?,?,?,0,?,?)',
        [input.package_name, input.package_amount, input.periods, input.count_devices, input.enabled ?? true, input.offer_only ?? false]);
      await record(db, req.user.id, 'coupon_package_created', insert.insertId);
      return insert.insertId;
    });
    res.status(201).json({ id: packageId });
  });
  router.patch('/api/admin/console/coupon-packages/:id', async (req, res) => {
    const packageId = id.parse(req.params.id);
    const input = couponPackage.parse(req.body);
    await transaction(pool, async db => {
      const [[existing]] = await db.execute('SELECT id, archived_at FROM packages_reseller WHERE id=? FOR UPDATE', [packageId]);
      if (!existing) throw new HttpError(404, 'Coupon package not found.');
      if (existing.archived_at) throw new HttpError(409, 'Restore the archived package before editing it.');
      const [updated] = await db.execute('UPDATE packages_reseller SET package_name=?,package_amount=?,periods=?,count_devices=?,enabled=COALESCE(?,enabled),offer_only=COALESCE(?,offer_only),updated_at=UTC_TIMESTAMP() WHERE id=?',
        [input.package_name, input.package_amount, input.periods, input.count_devices, input.enabled ?? null, input.offer_only ?? null, packageId]);
      if (!updated.affectedRows) throw new HttpError(404, 'Coupon package not found.');
      await record(db, req.user.id, 'coupon_package_updated', packageId);
    });
    res.json({ id: packageId });
  });

  router.get('/api/admin/console/coupon-packages/:id/deletion-preview', async (req, res) => {
    res.json(await previewRemoval(pool, id.parse(req.params.id)));
  });
  router.delete('/api/admin/console/coupon-packages/:id', async (req, res) => {
    res.json(await removePackage(pool, id.parse(req.params.id), req.user.id));
  });
  router.post('/api/admin/console/coupon-packages/:id/restore', async (req, res) => {
    res.json(await restorePackage(pool, id.parse(req.params.id), req.user.id));
  });

  router.get('/api/admin/console/payment-methods', async (_req, res) => {
    const [settings] = await pool.execute('SELECT method, enabled, instructions FROM velotv_checkout_settings');
    const existing = new Map(settings.map(item => [item.method, item]));
    res.json({ paypalConfigured: Boolean(paypal), methods: ['credits','paypal','manual'].map(method =>
      existing.get(method) ?? { method, enabled: true, instructions: '' }) });
  });
  router.patch('/api/admin/console/payment-methods/:method', async (req, res) => {
    const method = z.enum(['credits','paypal','manual']).parse(req.params.method);
    const { enabled, instructions } = z.object({ enabled: z.boolean(), instructions: z.string().trim().max(1000) }).strict().parse(req.body);
    await transaction(pool, async db => {
      await db.execute(`INSERT INTO velotv_checkout_settings(method,enabled,instructions) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE enabled=?, instructions=?`, [method, enabled, instructions, enabled, instructions]);
      await record(db, req.user.id, 'payment_' + method);
    });
    res.json({ method });
  });
  return router;
}

async function requireReseller(db, resellerId) {
  const [[row]] = await db.execute('SELECT id FROM resellers WHERE id = ? FOR UPDATE', [resellerId]);
  if (!row) throw new HttpError(404, 'Reseller not found.');
}

async function assertAvailableIdentity(db, input, except = 0) {
  const [[existing]] = await db.execute(`SELECT id FROM resellers
    WHERE id <> ? AND (email IN (?, ?) OR username IN (?, ?)) LIMIT 1 FOR UPDATE`,
  [except, input.email, input.username, input.email, input.username]);
  if (existing) throw new HttpError(409, 'This email or username is already used.');
}

module.exports = { adminRoutes };

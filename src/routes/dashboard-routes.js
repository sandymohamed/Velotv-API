const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { readPayments } = require('../models/credit-model');
const { listPackagePayments } = require('../models/payment-model');
const { redeemCoupon } = require('../services/device-service');
const { id, androidId } = require('../utils/validation');

const registerInput = z.object({
  android_id: androidId,
  type: id,
  id_coupon: id,
});
const deviceFilter = z.object({
  search: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(0).max(10000).default(0),
  status: z.enum(['all', 'active', 'expired', 'awaiting']).default('all'),
});

async function listDevices(pool, resellerId, filters) {
  const expiry = "STR_TO_DATE(d.ExipiredAt, '%Y-%m-%d %H:%i:%s')";
  const state = `CASE WHEN d.status <> 1 OR ${expiry} IS NULL OR ${expiry} <= UTC_TIMESTAMP() THEN 'expired'
    ELSE 'active' END`;
  const from = `FROM (SELECT id_device, MAX(id) AS last_id, COUNT(*) AS activations
    FROM reseller_devices WHERE id_reseller = ? GROUP BY id_device) r
    JOIN reseller_devices last_use ON last_use.id = r.last_id
    JOIN devices d ON d.id = r.id_device
    WHERE (? = '' OR LOCATE(LOWER(?), LOWER(COALESCE(d.android_id, d.mac, ''))) > 0)
      AND (? = 'all' OR ${state} = ?)`;
  const args = [resellerId, filters.search, filters.search, filters.status, filters.status];
  const [result] = await pool.execute(`SELECT d.id, d.mac, d.android_id, d.type, d.ExipiredAt AS expires_at,
    r.activations, last_use.created_at AS last_activation, ${state} AS state,
    r.last_id = (SELECT MAX(assignment.id) FROM reseller_devices assignment WHERE assignment.id_device = d.id) AS can_manage_playlists
    ${from} ORDER BY r.last_id DESC LIMIT 100 OFFSET ?`, [...args, filters.page * 100]);
  const [[{ count }]] = await pool.execute(`SELECT COUNT(*) AS count ${from}`, args);
  return { result, count };
}

function dashboardRoutes(pool, key) {
  const router = Router();
  const reseller = authenticate(pool, key, ['reseller']);
  router.get('/reseller/dashboard/catalog', reseller, async (_req, res) => {
    const [[packages], [types]] = await Promise.all([
      pool.execute(`SELECT id, package_name, package_amount, periods, count_devices
        FROM packages_reseller WHERE package_amount > 0 AND periods BETWEEN 1 AND 120
        AND count_devices BETWEEN 1 AND 1000 ORDER BY package_amount, id`),
      pool.execute('SELECT id, name FROM type_devices WHERE status = 1 ORDER BY id'),
    ]);
    res.json({ packages, types });
  });
  router.get('/reseller/dashboard/devices', reseller, async (req, res) => {
    res.json(await listDevices(pool, req.user.id, deviceFilter.parse(req.query)));
  });
  router.get('/reseller/dashboard/payments', reseller, async (req, res) => {
    const [balance, packages] = await Promise.all([
      readPayments(pool, req.user.id),
      listPackagePayments(pool, req.user.id),
    ]);
    res.json({ balance, packages });
  });
  router.post('/reseller/dashboard/devices/register-and-activate', reseller, async (req, res) => {
    res.json(await redeemCoupon(pool, req.user.id, registerInput.parse(req.body), { register: true }));
  });
  return router;
}

module.exports = { dashboardRoutes };

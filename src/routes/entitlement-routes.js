const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { createHash } = require('node:crypto');
const { z } = require('zod');
const { androidId } = require('../utils/validation');
const { HttpError } = require('../utils/errors');

const trialInput = z.object({ android_id: androidId });
const playInput = trialInput.extend({ purchase_token: z.string().min(1).max(4096) });

function entitlementRoutes(pool, verifyPlay) {
  const router = Router();
  const rate = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  router.post('/api/apps/entitlements/trial', rate, async (req, res) => {
    const { android_id } = trialInput.parse(req.body);
    const digest = createHash('sha256').update('velotv-trial:' + android_id).digest('hex');
    await pool.execute(`INSERT INTO velotv_standalone_trials (device_digest, started_at, expires_at)
      VALUES (?, UTC_TIMESTAMP(), TIMESTAMPADD(DAY, 7, UTC_TIMESTAMP()))
      ON DUPLICATE KEY UPDATE device_digest = device_digest`, [digest]);
    const [[trial]] = await pool.execute(`SELECT
      TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', expires_at) DIV 1000 AS expiresAt,
      expires_at > UTC_TIMESTAMP() AS active FROM velotv_standalone_trials WHERE device_digest = ?`, [digest]);
    res.json({ grant: trial.active ? {
      source: 'trial', plan: 'seven_day_trial', status: 'active', expiresAt: Number(trial.expiresAt),
      verifiedAt: Date.now(),
    } : null });
  });
  router.get('/api/apps/entitlements/google-play', rate, (_req, res) => {
    if (!verifyPlay) throw new HttpError(503, 'Google Play verification is not configured');
    res.json({ productId: verifyPlay.product, basePlanId: verifyPlay.basePlan });
  });
  router.post('/api/apps/entitlements/google-play', rate, async (req, res) => {
    if (!verifyPlay) throw new HttpError(503, 'Google Play verification is not configured');
    const { android_id, purchase_token } = playInput.parse(req.body);
    res.json({ grant: await verifyPlay(android_id, purchase_token) });
  });
  return router;
}

module.exports = { entitlementRoutes };

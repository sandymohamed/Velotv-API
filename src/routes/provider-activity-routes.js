const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const { transaction } = require('../config/database');
const { findAndroidDevice, isActiveDevice } = require('../models/device-model');
const activity = require('../models/provider-activity-model');
const { HttpError } = require('../utils/errors');
const { androidId, id } = require('../utils/validation');

const identity = z.object({ android_id: androidId, device_type: id, profileid: id }).strict();
const content = z.enum(['live', 'movie', 'serie']);
const item = identity.extend({ type: content, streamid: z.string().trim().min(1).max(4096) });

async function authorize(db, input, lock = false) {
  const device = await findAndroidDevice(db, input.android_id, input.device_type, lock);
  if (!device || !await activity.ownsProfile(db, device.id, input.profileid, !isActiveDevice(device))) {
    throw new HttpError(403, 'Provider playlist is unavailable for this device');
  }
}

function providerActivityRoutes(pool) {
  const router = Router();
  const limit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false });

  router.post('/api/v2/favorites/selectall', limit, async (req, res) => {
    const input = identity.extend({ type: content }).parse(req.body);
    await authorize(pool, input);
    res.json({ data: await activity.listFavorites(pool, input) });
  });
  router.post('/api/v2/recents/selectrecentAll', limit, async (req, res) => {
    const input = identity.parse(req.body);
    await authorize(pool, input);
    res.json({ data: await activity.listRecents(pool, input) });
  });
  for (const [path, schema, write] of [
    ['/api/v2/favorites/createDelete', item.extend({ enabled: z.boolean() }), activity.setFavorite],
    ['/api/v2/recents/insertDatarecent', item, activity.recordRecent],
  ]) {
    router.post(path, limit, async (req, res) => {
      const input = schema.parse(req.body);
      await transaction(pool, async db => {
        await authorize(db, input, true);
        await write(db, input);
      });
      res.json({ success: true });
    });
  }
  return router;
}

module.exports = { providerActivityRoutes };

const { Router } = require('express');
const { z } = require('zod');
const { createRateLimit: rateLimit } = require('../middleware/rate-limit');
const { authenticate } = require('../middleware/auth');
const { activeReseller } = require('../services/reseller-access');
const { transaction } = require('../config/database');
const { listProfiles } = require('../models/device-model');
const model = require('../models/device-playlists-model');
const { androidId, id } = require('../utils/validation');
const { HttpError } = require('../utils/errors');

const url = z.string().trim().max(4096).refine(value => {
  const parsed = URL.parse(value);
  return parsed && ['http:', 'https:'].includes(parsed.protocol) &&
    !parsed.username && !parsed.password && !parsed.hash;
});
const fields = { name: z.string().trim().min(1).max(255), url };
const playlist = z.discriminatedUnion('format', [
  z.object({ ...fields, format: z.literal('m3u') }).strict(),
  z.object({
    ...fields, format: z.literal('xtream'),
    url: url.refine(value => URL.parse(value)?.search === ''),
    username: z.string().trim().min(1).max(255),
    password: z.string().min(1).max(255),
  }).strict(),
]);
const publicBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), android_id: androidId, playlist }).strict(),
  z.object({ action: z.literal('delete_all'), android_id: androidId }).strict(),
]);

function devicePlaylistsRoutes(pool, key) {
  const router = Router();
  const reseller = authenticate(pool, key, ['reseller']);
  const publicLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  const path = '/reseller/dashboard/devices/:deviceId/playlists';

  router.post('/api/public/device-playlists', publicLimit, async (req, res) => {
    const input = publicBody.parse(req.body);
    const result = await transaction(pool, async db => {
      const devices = await model.findPublicDevice(db, input.android_id);
      if (!devices.length) throw new HttpError(404, 'Device not found. Open Device Info in VeloTV and press Refresh.');
      if (devices.length !== 1) throw new HttpError(409, 'This Android ID matches more than one device record. Contact support.');
      const [{ id: deviceId }] = devices;
      if (input.action === 'delete_all') return { deleted: await model.deletePlaylists(db, deviceId) };
      await model.addPlaylist(db, deviceId, input.playlist);
      return { success: true };
    });
    res.status(input.action === 'add' ? 201 : 200).json(result);
  });

  router.get(path, reseller, async (req, res) => {
    const deviceId = id.parse(req.params.deviceId);
    const playlists = await transaction(pool, async db => {
      await requireOwnedDevice(db, deviceId, req.user.id);
      return listProfiles(db, deviceId);
    });
    res.json({ playlists });
  });

  router.post(path, reseller, async (req, res) => {
    const input = playlist.parse(req.body);
    const profileId = await write(req, (db, deviceId) => model.addPlaylist(db, deviceId, input, req.user.id));
    res.status(201).json({ id: profileId });
  });

  router.patch(path + '/:profileId', reseller, async (req, res) => {
    const profileId = id.parse(req.params.profileId);
    const input = playlist.parse(req.body);
    await write(req, async (db, deviceId) => {
      if (!await model.updatePlaylist(db, deviceId, profileId, input)) throw new HttpError(404, 'Playlist not found.');
    });
    res.json({ success: true });
  });

  router.delete(path + '/:profileId', reseller, async (req, res) => {
    const profileId = id.parse(req.params.profileId);
    await write(req, async (db, deviceId) => {
      if (!await model.deletePlaylists(db, deviceId, profileId)) throw new HttpError(404, 'Playlist not found.');
    });
    res.json({ success: true });
  });

  async function write(req, action) {
    const deviceId = id.parse(req.params.deviceId);
    return transaction(pool, async db => {
      if (!await activeReseller(db, req.user.id, true)) throw new HttpError(403, 'Reseller access is inactive.');
      await requireOwnedDevice(db, deviceId, req.user.id);
      return action(db, deviceId);
    });
  }
  return router;
}

async function requireOwnedDevice(db, deviceId, resellerId) {
  if (!await model.resellerDevice(db, deviceId, resellerId)) {
    throw new HttpError(404, 'Device not found or managed by another reseller.');
  }
}

module.exports = { devicePlaylistsRoutes };

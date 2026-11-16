const express = require('express');
const helmet = require('helmet');
const { ZodError } = require('zod');
const { HttpError } = require('./utils/errors');
const { entitlementRoutes } = require('./routes/entitlement-routes');
const { adminRoutes } = require('./routes/admin-routes');
const { dashboardRoutes } = require('./routes/dashboard-routes');
const { legacyRoutes } = require('./routes/legacy-routes');
const { devicePlaylistsRoutes } = require('./routes/device-playlists-routes');
const { providerActivityRoutes } = require('./routes/provider-activity-routes');

function createApp(pool, key, paypal = null, verifyPlay = null) {
  if (!/^[0-9a-f]{64}$/i.test(key ?? '')) throw new Error('JWT_SECRET must contain 64 hex characters');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/health', async (_req, res) => {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok' });
  });
  const dashboardOrigins = new Set((process.env.DASHBOARD_ORIGINS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean));
  app.use((req, res, next) => {
    res.vary('Origin');
    if (dashboardOrigins.has(req.get('Origin'))) {
      res.set('Access-Control-Allow-Origin', req.get('Origin'));
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });
  app.use(adminRoutes(pool, Buffer.from(key, 'hex'), paypal));
  app.use(dashboardRoutes(pool, Buffer.from(key, 'hex')));
  app.use(entitlementRoutes(pool, verifyPlay));
  app.use(devicePlaylistsRoutes(pool, Buffer.from(key, 'hex')));
  app.use(providerActivityRoutes(pool));
  app.use(legacyRoutes(pool, Buffer.from(key, 'hex'), paypal));
  app.use((_req, res) => res.status(404).json({ error: true, message: 'Route unavailable in this build' }));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: true, message: error.message });
    if (error instanceof ZodError || error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: true, message: 'Invalid request' });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: true, message: 'Request too large' });
    console.error('Request failed:', error.code || error.name);
    return res.status(500).json({ error: true, message: 'Internal error' });
  });
  return app;
}
module.exports = { createApp };

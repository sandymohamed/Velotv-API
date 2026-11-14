const { connectDatabase } = require('./config/database');
const { migrate } = require('./config/migrations');
const { createPayPal } = require('./config/paypal');
const { createGooglePlay } = require('./services/google-play-service');
const { createApp } = require('./app');

async function start() {
  const pool = await connectDatabase();
  try {
    const app = createApp(pool, process.env.JWT_SECRET, createPayPal(), createGooglePlay());
    if (process.env.DB_AUTO_MIGRATE !== 'false') await migrate(pool);
    const port = Number(process.env.PORT ?? 3000);
    const server = app.listen(port, () => console.log('VeloTV API ready on port', port));
    server.on('error', error => {
      console.error('HTTP startup failed:', error.code || error.name);
      void pool.end().finally(() => { process.exitCode = 1; });
    });
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => server.close(() => { void pool.end(); }));
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
}

start().catch(error => {
  console.error('Startup failed:', error.code || error.message);
  process.exitCode = 1;
});

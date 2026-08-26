/**
 * Entry point: boots the HTTP server.
 *
 * Run with:
 *   npm run dev    (nodemon, restarts on file changes)
 *   npm start      (plain node)
 */

const app = require('./app');
const { config, warnAboutConfig } = require('./config/env');

warnAboutConfig();

const server = app.listen(config.port, () => {
  console.log('');
  console.log('  RecoverAI backend is running');
  console.log(`  Environment : ${config.nodeEnv}`);
  console.log(`  URL         : http://localhost:${config.port}`);
  console.log(`  Health      : http://localhost:${config.port}/api/health`);
  if (!config.isProduction) {
    console.log(
      `  Razorpay    : http://localhost:${config.port}/api/test/razorpay`
    );
  }
  console.log('');
});

// Clear message instead of a raw stack trace when the port is already taken.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[server] Port ${config.port} is already in use. ` +
        'Stop the other process or set a different PORT in backend/.env.'
    );
    process.exit(1);
  }
  console.error('[server] Failed to start:', error.message);
  process.exit(1);
});

// Last-resort safety nets so the process never dies silently.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[server] Uncaught exception:', error.message);
  process.exit(1);
});

// Shut down cleanly on Ctrl+C / container stop.
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
});

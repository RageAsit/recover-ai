/**
 * Central environment configuration.
 *
 * Every other file imports config from here instead of touching `process.env`
 * directly. That gives us one single place to add validation, defaults and
 * safety checks as the project grows.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load `backend/.env` (works no matter which directory you run npm from).
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Origins allowed to call this API. Comma-separated in .env.
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    // SECRET: server-side only. Never returned by an API, never logged.
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    baseUrl: 'https://api.razorpay.com/v1',
    timeoutMs: 10000,
  },
};

config.isProduction = config.nodeEnv === 'production';

/** True when both Razorpay credentials are present. */
function hasRazorpayCredentials() {
  return Boolean(config.razorpay.keyId && config.razorpay.keySecret);
}

/**
 * Razorpay test keys start with `rzp_test_`, live keys with `rzp_live_`.
 * This project must only ever talk to Test Mode.
 */
function isTestModeKey() {
  return config.razorpay.keyId.startsWith('rzp_test_');
}

/**
 * Turns `rzp_test_AbCdEf123456` into `rzp_test_****3456` so we can safely show
 * which key is in use without revealing it.
 */
function maskKeyId(keyId = config.razorpay.keyId) {
  if (!keyId) return null;
  if (keyId.length <= 4) return '****';
  return `${keyId.slice(0, 9)}****${keyId.slice(-4)}`;
}

/**
 * Prints non-fatal warnings at startup. We intentionally do NOT crash when
 * Razorpay credentials are missing so that `GET /api/health` still works and
 * you can boot the server before you have keys.
 */
function warnAboutConfig(log = console) {
  if (!hasRazorpayCredentials()) {
    log.warn(
      '[config] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. ' +
        'Copy .env.example to .env and add your Test Mode keys. ' +
        'GET /api/test/razorpay will fail until then.'
    );
    return;
  }

  if (!isTestModeKey()) {
    log.warn(
      '[config] RAZORPAY_KEY_ID does not start with "rzp_test_". ' +
        'RecoverAI only supports Razorpay Test Mode - requests will be refused.'
    );
  }
}

module.exports = {
  config,
  hasRazorpayCredentials,
  isTestModeKey,
  maskKeyId,
  warnAboutConfig,
};

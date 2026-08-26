/**
 * The single place where RecoverAI talks to Razorpay.
 *
 * Everything else in the app (routes today, agent tools later) calls the
 * functions exported here instead of making its own HTTP requests. That means
 * authentication, timeouts and error sanitisation are implemented exactly once.
 */

const axios = require('axios');

const {
  config,
  hasRazorpayCredentials,
  isTestModeKey,
  maskKeyId,
} = require('../config/env');

/**
 * Error type for anything that goes wrong while talking to Razorpay.
 * `statusCode` is the HTTP status our own API should respond with, and
 * `details` is already sanitised (no credentials, no auth headers).
 */
class RazorpayServiceError extends Error {
  constructor(message, { statusCode = 502, details = {} } = {}) {
    super(message);
    this.name = 'RazorpayServiceError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

let cachedClient = null;

/**
 * Builds (and caches) the axios instance used for Razorpay calls.
 *
 * Razorpay's REST API uses HTTP Basic Auth: the key id is the username and the
 * key secret is the password. Axios' `auth` option base64-encodes them into an
 * `Authorization: Basic <...>` header for every request, so the secret only
 * ever lives in this process's memory - never in a URL, log line or response.
 */
function getClient() {
  if (!hasRazorpayCredentials()) {
    throw new RazorpayServiceError(
      'Razorpay credentials are not configured on the server.',
      {
        statusCode: 500,
        details: {
          hint: 'Copy backend/.env.example to backend/.env and set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.',
        },
      }
    );
  }

  if (!isTestModeKey()) {
    throw new RazorpayServiceError(
      'Refusing to call Razorpay: RecoverAI only supports Test Mode credentials.',
      {
        statusCode: 400,
        details: { hint: 'RAZORPAY_KEY_ID must start with "rzp_test_".' },
      }
    );
  }

  if (!cachedClient) {
    cachedClient = axios.create({
      baseURL: config.razorpay.baseUrl,
      timeout: config.razorpay.timeoutMs,
      auth: {
        username: config.razorpay.keyId,
        password: config.razorpay.keySecret,
      },
      headers: { Accept: 'application/json' },
    });
  }

  return cachedClient;
}

/**
 * Converts an axios failure into a RazorpayServiceError.
 *
 * We deliberately copy only a handful of fields out of the axios error. The raw
 * error object contains `error.config`, which includes the Authorization
 * header - so it must never be forwarded to a client or a log.
 */
function toServiceError(error, context) {
  // Our own guard errors pass straight through.
  if (error instanceof RazorpayServiceError) return error;

  // Razorpay answered with a 4xx/5xx.
  if (error.response) {
    const status = error.response.status;
    const razorpayError = (error.response.data && error.response.data.error) || {};

    const message =
      razorpayError.description ||
      `Razorpay rejected the request with status ${status}.`;

    return new RazorpayServiceError(message, {
      // 401/403 mean *our* keys are wrong -> that is a server config problem.
      statusCode: status === 401 || status === 403 ? 500 : 502,
      details: {
        context,
        razorpayStatus: status,
        razorpayErrorCode: razorpayError.code || null,
        hint:
          status === 401
            ? 'Razorpay did not accept the key id / secret pair. Re-check your Test Mode keys in backend/.env.'
            : undefined,
      },
    });
  }

  // Request left but no answer came back (DNS, offline, timeout).
  if (error.request) {
    return new RazorpayServiceError(
      'No response from Razorpay. Check your internet connection and try again.',
      {
        statusCode: 504,
        details: { context, reason: error.code || 'NO_RESPONSE' },
      }
    );
  }

  // Something broke before the request was even sent.
  return new RazorpayServiceError('Failed to build the Razorpay request.', {
    statusCode: 500,
    details: { context, reason: error.code || 'REQUEST_SETUP_FAILED' },
  });
}

/**
 * Safe, read-only connectivity check.
 *
 * Fetches at most one payment (`GET /v1/payments?count=1`). It creates nothing,
 * changes nothing and charges nobody - it only proves that the server can
 * authenticate against Razorpay Test Mode. An empty test account is a valid
 * success: the account simply has no payments yet.
 *
 * @returns {Promise<object>} sanitised result - contains no credentials.
 */
async function checkConnection() {
  const client = getClient();
  const startedAt = Date.now();

  try {
    const response = await client.get('/payments', { params: { count: 1 } });
    const payments = (response.data && response.data.items) || [];

    return {
      connected: true,
      mode: 'test',
      keyId: maskKeyId(),
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      // Metadata only - we never echo payment details at this stage.
      paymentsVisible: payments.length,
      note:
        payments.length === 0
          ? 'Authenticated successfully. This Test Mode account has no payments yet.'
          : 'Authenticated successfully and able to read Test Mode payments.',
    };
  } catch (error) {
    throw toServiceError(error, 'GET /v1/payments');
  }
}

module.exports = {
  RazorpayServiceError,
  checkConnection,
};

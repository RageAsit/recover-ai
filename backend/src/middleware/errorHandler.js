/**
 * Error handling middleware.
 *
 * Express calls `errorHandler` whenever a route passes an error to `next()`.
 * It is the only place that shapes error responses, which is what keeps
 * credentials and stack traces out of the JSON we send back.
 */

const { config } = require('../config/env');
const { RazorpayServiceError } = require('../services/razorpay.service');

/** Runs when no route matched the request. */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
function errorHandler(error, req, res, next) {
  const isKnownError = error instanceof RazorpayServiceError;
  const statusCode = isKnownError ? error.statusCode : error.statusCode || 500;

  // Log for the developer. We log the message and our own sanitised details -
  // never `error.config` / `error.request`, which carry the Authorization header.
  console.error(
    `[error] ${req.method} ${req.originalUrl} -> ${statusCode}: ${error.message}`
  );

  const body = {
    success: false,
    error: {
      // Unknown errors get a generic message so internals are not exposed.
      message: isKnownError ? error.message : 'Internal server error.',
      type: isKnownError ? 'razorpay_service_error' : 'server_error',
    },
  };

  if (isKnownError && error.details) {
    // `details` is built by hand in the service and is safe to return.
    body.error.details = error.details;
  }

  // Stack traces are useful locally and dangerous in production.
  if (!config.isProduction && error.stack) {
    body.error.stack = error.stack.split('\n').slice(0, 5);
  }

  res.status(statusCode).json(body);
}

module.exports = { notFoundHandler, errorHandler };

const crypto = require("crypto");

/**
 * Razorpay webhook signature verification (HMAC-SHA256).
 *
 * Razorpay signs the EXACT raw request body with your webhook secret and sends
 * the hex digest in the `X-Razorpay-Signature` header. We recompute the digest
 * over the same raw bytes and compare in constant time.
 *
 * This deliberately uses RAZORPAY_WEBHOOK_SECRET, NOT the API key secret -
 * they are different secrets (see explanation in the step notes).
 */

/**
 * @returns {boolean} whether a non-empty webhook secret is configured.
 */
function isWebhookSecretConfigured() {
  return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
}

/**
 * Timing-safe compare of two hex signature strings.
 * Returns false (never throws) on any length/format mismatch, so it can't be
 * used as an oracle and can't crash the request.
 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  let bufA;
  let bufB;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }

  // Unequal lengths can't be compared by timingSafeEqual, and unequal length
  // already means "not equal". Bail before the length itself leaks via throw.
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a webhook against its signature header.
 *
 * @param {Buffer|string} rawBody   Exact bytes Razorpay sent (from express.raw()).
 * @param {string} signatureHeader  Value of X-Razorpay-Signature.
 * @returns {{ valid: boolean, reason?: "missing_secret" | "missing_signature" | "no_body" | "invalid_signature" }}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!isWebhookSecretConfigured()) return { valid: false, reason: "missing_secret" };
  if (!signatureHeader || typeof signatureHeader !== "string") {
    return { valid: false, reason: "missing_signature" };
  }
  if (rawBody === undefined || rawBody === null || rawBody.length === 0) {
    return { valid: false, reason: "no_body" };
  }

  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody) // Buffer or string; the raw bytes, never re-serialized JSON
    .digest("hex");

  if (!timingSafeEqualHex(expected, signatureHeader)) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

module.exports = {
  verifyWebhookSignature,
  isWebhookSecretConfigured,
  timingSafeEqualHex,
};

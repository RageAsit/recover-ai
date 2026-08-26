const mongoose = require("mongoose");
const { verifyWebhookSignature } = require("../services/webhookSignature");
const {
  parseWebhookBody,
  normalizePaymentEvent,
  isSupportedEvent,
  logEvent,
} = require("../services/webhookEvents");
const { savePaymentFromEvent } = require("../services/paymentStore");

/**
 * POST /api/webhooks/razorpay
 *
 * Flow: raw body -> HMAC-SHA256 signature verification -> JSON parse ->
 * classify event -> normalize a small payment object -> log -> persist ->
 * acknowledge.
 *
 * Parsing happens ONLY after verification succeeds: every failure path below
 * the signature check returns before the body is read.
 */
async function receiveRazorpayWebhook(req, res) {
  // express.raw() sets req.body to a Buffer. Anything else means no raw body
  // reached us (wrong middleware order), so we cannot verify and must reject.
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    console.error(
      "[webhook] Raw body missing - express.raw() did not run. Check middleware order."
    );
    return res.status(400).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  const signature = req.get("X-Razorpay-Signature");
  const verification = verifyWebhookSignature(rawBody, signature);

  if (!verification.valid) {
    // Log the precise reason server-side (never the secret or the signature),
    // but return one uniform message so the response can't be used to probe
    // whether the secret is configured.
    console.warn(`[webhook] Rejected webhook: ${verification.reason}`);

    if (verification.reason === "missing_secret") {
      console.error(
        "[webhook] RAZORPAY_WEBHOOK_SECRET is not set in .env - all webhooks will be rejected."
      );
    }

    return res.status(401).json({
      success: false,
      message: "Invalid webhook signature",
    });
  }

  // ---- Signature verified. Only now is the body parsed. ----

  const parsed = parseWebhookBody(rawBody);

  if (!parsed.ok) {
    console.warn(`[webhook] Verified webhook had an unusable body: ${parsed.reason}`);
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload",
    });
  }

  const normalized = normalizePaymentEvent(parsed.body);

  // A Razorpay event always names itself; without that we can't classify it.
  if (!normalized.event) {
    console.warn("[webhook] Verified webhook had no event name");
    return res.status(400).json({
      success: false,
      message: "Invalid webhook payload",
    });
  }

  logEvent(normalized);

  // Supported and unsupported events both get 200 - acknowledging an event we
  // don't handle stops Razorpay retrying it indefinitely.
  if (!isSupportedEvent(normalized.event)) {
    return res.status(200).json({
      success: true,
      received: true,
      event: normalized.event,
    });
  }

  // ---- Supported event: persist to MongoDB. ----

  // Fail fast if MongoDB is not connected rather than letting mongoose buffer
  // the command and hang the webhook for seconds.
  if (mongoose.connection.readyState !== 1) {
    console.error("[webhook] MongoDB not connected - cannot persist event");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    await savePaymentFromEvent(normalized);
    console.log(`[webhook] Persisted ${normalized.event}: paymentId=${normalized.paymentId}`);
  } catch (err) {
    console.error(`[webhook] Failed to persist ${normalized.event}: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to persist event",
    });
  }

  return res.status(200).json({
    success: true,
    received: true,
    event: normalized.event,
  });
}

module.exports = { receiveRazorpayWebhook };


/**
 * Parsing, classification and normalization of VERIFIED Razorpay webhook events.
 *
 * Nothing here runs until the HMAC signature has been verified - see
 * controllers/webhookController.js. Every field access is defensive because a
 * payload may omit optional fields or be shaped unexpectedly; a malformed body
 * must never crash the server.
 *
 * Deliberately NOT done here: persistence, idempotency, recovery, notifications.
 */

const SUPPORTED_EVENTS = Object.freeze(["payment.failed", "payment.captured"]);

/** Narrowing helpers - each returns null instead of throwing on bad input. */
function asString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function asInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Keeps dev logs readable when an upstream message is unexpectedly long. */
function truncate(text, max = 120) {
  if (typeof text !== "string") return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * JSON-parse the raw webhook body.
 *
 * @param {Buffer|string} rawBody
 * @returns {{ ok: true, body: Object } | { ok: false, reason: "no_body" | "malformed_json" | "not_an_object" }}
 */
function parseWebhookBody(rawBody) {
  let text;
  if (Buffer.isBuffer(rawBody)) {
    text = rawBody.toString("utf8");
  } else if (typeof rawBody === "string") {
    text = rawBody;
  } else {
    return { ok: false, reason: "no_body" };
  }

  if (text.trim() === "") return { ok: false, reason: "no_body" };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed_json" };
  }

  // Valid JSON can still be a scalar or array ("hello", 42, []); a Razorpay
  // event is always an object.
  const body = asObject(parsed);
  if (!body) return { ok: false, reason: "not_an_object" };

  return { ok: true, body };
}

/**
 * Razorpay nests the payment under payload.payment.entity.
 * Returns null if any level is missing or not an object.
 */
function getPaymentEntity(body) {
  const payload = asObject(body.payload);
  if (!payload) return null;

  const payment = asObject(payload.payment);
  if (!payment) return null;

  return asObject(payment.entity);
}

/**
 * Build the small internal representation used by the rest of the app, so the
 * full Razorpay payload never has to be passed around.
 *
 * Every field is null when unavailable - never undefined, never throwing.
 * Deliberately excludes customer data (email, contact, card details).
 *
 * @returns {{event: string|null, paymentId: string|null, orderId: string|null,
 *            amount: number|null, currency: string|null, status: string|null,
 *            method: string|null, failureReason: string|null}}
 */
function normalizePaymentEvent(body) {
  const safeBody = asObject(body) || {};
  const entity = getPaymentEntity(safeBody) || {};

  // Razorpay reports failures across three fields; prefer the most descriptive.
  const failureReason =
    asString(entity.error_description) ??
    asString(entity.error_reason) ??
    asString(entity.error_code);

  return {
    event: asString(safeBody.event),
    paymentId: asString(entity.id),
    orderId: asString(entity.order_id),
    amount: asInteger(entity.amount),
    currency: asString(entity.currency),
    status: asString(entity.status),
    method: asString(entity.method),
    failureReason,
  };
}

function isSupportedEvent(eventName) {
  return SUPPORTED_EVENTS.includes(eventName);
}

/**
 * Log a concise development message for the event. No action is taken:
 * recovery logic belongs to a later step.
 *
 * Logs identifiers and amounts only - never the full payload or customer data.
 */
function logEvent(normalized) {
  const { event, paymentId, orderId, amount } = normalized;

  if (event === "payment.failed") {
    console.log(
      `[webhook] Payment failed: paymentId=${paymentId} orderId=${orderId} ` +
        `amount=${amount} reason=${truncate(normalized.failureReason)}`
    );
    return;
  }

  if (event === "payment.captured") {
    console.log(
      `[webhook] Payment captured: paymentId=${paymentId} orderId=${orderId} amount=${amount}`
    );
    return;
  }

  console.log(`[webhook] Unhandled event: ${event} (acknowledged, no action taken)`);
}

module.exports = {
  SUPPORTED_EVENTS,
  parseWebhookBody,
  normalizePaymentEvent,
  isSupportedEvent,
  logEvent,
};

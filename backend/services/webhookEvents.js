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

const SUPPORTED_EVENTS = Object.freeze([
  "payment.failed",
  "payment.captured",
  "payment_link.paid",
]);
const SENTINEL_EMAILS = Object.freeze(["void@razorpay.com"]);

/** Narrowing helpers - each returns null instead of throwing on bad input. */
function asString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Normalizes email: returns null if missing, empty, or matching known placeholder sentinels.
 */
function sanitizeCustomerEmail(rawEmail) {
  const email = asString(rawEmail);
  if (!email) return null;
  if (SENTINEL_EMAILS.includes(email.trim().toLowerCase())) {
    return null;
  }
  return email;
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
 * Razorpay nests the payment link under payload.payment_link.entity.
 * Returns null if any level is missing or not an object.
 */
function getPaymentLinkEntity(body) {
  const payload = asObject(body.payload);
  if (!payload) return null;

  const paymentLink = asObject(payload.payment_link);
  if (!paymentLink) return null;

  return asObject(paymentLink.entity);
}

/**
 * Razorpay nests the order under payload.order.entity.
 * Returns null if any level is missing or not an object.
 */
function getOrderEntity(body) {
  const payload = asObject(body.payload);
  if (!payload) return null;

  const order = asObject(payload.order);
  if (!order) return null;

  return asObject(order.entity);
}

/**
 * Build the small internal representation used by the rest of the app, so the
 * full Razorpay payload never has to be passed around.
 *
 * Every field is null when unavailable - never undefined, never throwing.
 * Email and contact are captured because the CREATE_PAYMENT_LINK recovery action
 * requires them to notify the payer. Card details remain excluded.
 * Placeholder/sentinel emails (e.g. "void@razorpay.com") normalize to null.
 *
 * @returns {{event: string|null, paymentId: string|null, orderId: string|null,
 *            amount: number|null, currency: string|null, status: string|null,
 *            method: string|null, failureReason: string|null,
 *            customerEmail: string|null, customerContact: string|null,
 *            paymentLinkId: string|null, paymentLinkReferenceId: string|null,
 *            paymentLinkStatus: string|null}}
 */
function normalizePaymentEvent(body) {
  const safeBody = asObject(body) || {};
  const paymentEntity = getPaymentEntity(safeBody) || {};
  const linkEntity = getPaymentLinkEntity(safeBody) || {};
  const orderEntity = getOrderEntity(safeBody) || {};

  // Razorpay reports failures across three fields; prefer the most descriptive.
  const failureReason =
    asString(paymentEntity.error_description) ??
    asString(paymentEntity.error_reason) ??
    asString(paymentEntity.error_code);

  const amount =
    asInteger(paymentEntity.amount) ??
    asInteger(linkEntity.amount_paid) ??
    asInteger(linkEntity.amount) ??
    asInteger(orderEntity.amount);

  const orderId =
    asString(paymentEntity.order_id) ??
    asString(linkEntity.order_id) ??
    asString(orderEntity.id);

  return {
    event: asString(safeBody.event),
    paymentId: asString(paymentEntity.id),
    orderId,
    amount,
    currency: asString(paymentEntity.currency) ?? asString(linkEntity.currency),
    status: asString(paymentEntity.status) ?? asString(linkEntity.status),
    method: asString(paymentEntity.method),
    failureReason,
    customerEmail: sanitizeCustomerEmail(paymentEntity.email),
    // Leave customerContact as-is: no placeholder/sentinel phone values
    // have been observed in practice; do not invent one.
    customerContact: asString(paymentEntity.contact),
    paymentLinkId: asString(linkEntity.id),
    paymentLinkReferenceId: asString(linkEntity.reference_id),
    paymentLinkStatus: asString(linkEntity.status),
  };
}

function isSupportedEvent(eventName) {
  return SUPPORTED_EVENTS.includes(eventName);
}

/**
 * Log a concise development message for the event.
 *
 * Logs identifiers, statuses, and amounts only - never customer contact/email
 * or short URLs.
 */
function logEvent(normalized) {
  const { event, paymentId, orderId, amount, paymentLinkId, paymentLinkReferenceId, paymentLinkStatus } = normalized;

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

  if (event === "payment_link.paid") {
    console.log(
      `[webhook] Payment link paid: linkId=${paymentLinkId} referenceId=${paymentLinkReferenceId} ` +
        `status=${paymentLinkStatus} amount=${amount}${paymentId ? ` paymentId=${paymentId}` : ""}${orderId ? ` orderId=${orderId}` : ""}`
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

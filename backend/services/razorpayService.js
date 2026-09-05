const Razorpay = require("razorpay");

let client = null;

/**
 * Returns the names of any required Razorpay env vars that are missing/empty.
 */
function getMissingCredentials() {
  const missing = [];
  if (!process.env.RAZORPAY_KEY_ID) missing.push("RAZORPAY_KEY_ID");
  if (!process.env.RAZORPAY_KEY_SECRET) missing.push("RAZORPAY_KEY_SECRET");
  return missing;
}

/**
 * Strips credentials out of any string before it leaves the server.
 * Defence-in-depth: the SDK should never leak these, but we never rely on that.
 */
function redact(text) {
  if (typeof text !== "string") return "";
  let out = text;
  const secrets = [
    process.env.RAZORPAY_KEY_SECRET,
    process.env.RAZORPAY_WEBHOOK_SECRET,
    process.env.RAZORPAY_KEY_ID,
  ];
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out.replace(/rzp_(test|live)_[A-Za-z0-9]+/g, "[REDACTED]");
}

/**
 * Lazily builds the Razorpay client so that missing credentials surface as a
 * handled request error instead of crashing the process at startup.
 */
function getRazorpayClient() {
  const missing = getMissingCredentials();
  if (missing.length > 0) {
    const err = new Error(`Missing environment variable(s): ${missing.join(", ")}`);
    err.code = "MISSING_CREDENTIALS";
    throw err;
  }

  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }

  return client;
}

/**
 * Safe, read-only auth check against Razorpay Test Mode.
 * Fetches at most one payment; creates and modifies nothing.
 */
async function verifyConnection() {
  const razorpay = getRazorpayClient();
  await razorpay.payments.all({ count: 1 });
}

/**
 * Converts any thrown error into a small, credential-free shape safe to return.
 */
function describeError(err) {
  // Already sanitized by toSafeError() — trust its fields, re-redact defensively.
  if (err && err.isSanitized) {
    return {
      status: err.httpStatus || 502,
      reason: err.reason || "razorpay_error",
      statusCode: err.statusCode,
      detail: redact(err.message),
    };
  }

  if (err && err.code === "MISSING_CREDENTIALS") {
    return {
      status: 500,
      reason: "missing_credentials",
      detail: redact(err.message),
    };
  }

  // Razorpay API error (e.g. 401 on bad keys). Only the documented,
  // non-sensitive fields are read — never the raw error object.
  if (err && err.statusCode) {
    return {
      status: 502,
      reason: "razorpay_api_error",
      statusCode: err.statusCode,
      detail: redact(err.error?.description || "Razorpay returned an error response"),
    };
  }

  // Network/DNS/timeout and anything else unexpected.
  return {
    status: 502,
    reason: "network_or_unknown_error",
    detail: redact(err?.code || err?.message || "Unexpected error"),
  };
}

/**
 * Rebuilds an SDK/network error as a plain Error carrying only safe fields.
 * The raw SDK error is deliberately discarded so request config and auth
 * headers can never reach a caller, a log, or an API response.
 */
function toSafeError(err) {
  if (err && (err.isSanitized || err.code === "MISSING_CREDENTIALS")) return err;

  const described = describeError(err);
  const safe = new Error(described.detail);
  safe.isSanitized = true;
  safe.reason = described.reason;
  safe.statusCode = described.statusCode;
  safe.httpStatus = described.status;
  return safe;
}

/**
 * Creates a Razorpay Order.
 *
 * IMPORTANT: `amount` is in the smallest currency unit (paise for INR).
 * This function performs NO rupee -> paise conversion, because that is how the
 * Razorpay API represents amounts. Callers must convert before calling.
 *   ₹2,499.00  =>  amount: 249900
 *
 * @param {Object}  params
 * @param {number}  params.amount              Amount in paise; positive integer.
 * @param {string}  [params.currency="INR"]    ISO currency code.
 * @param {string}  [params.receipt]           Your own reference id (Razorpay caps this at 40 chars).
 * @returns {Promise<Object>} The Razorpay order object (id, amount, currency, receipt, status, ...).
 * @throws {Error} A sanitized error; never contains credentials. Inspect
 *                 `err.reason` / `err.statusCode`, or pass it to describeError().
 */
async function createOrder({ amount, currency = "INR", receipt } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error(
      "amount must be a positive integer in paise (e.g. 249900 for Rs 2,499.00)"
    );
    err.isSanitized = true;
    err.reason = "invalid_amount";
    err.httpStatus = 400;
    throw err;
  }

  // Throws MISSING_CREDENTIALS (already safe) when env vars are unset.
  const razorpay = getRazorpayClient();

  const payload = { amount, currency };
  if (receipt !== undefined && receipt !== null) payload.receipt = receipt;

  try {
    return await razorpay.orders.create(payload);
  } catch (err) {
    throw toSafeError(err);
  }
}

/**
 * Creates a Razorpay Payment Link.
 *
 * CRITICAL SAFETY RULES:
 * - `amount` is in paise and passed through with NO conversion.
 * - `referenceId` is REQUIRED for idempotency on Razorpay's side.
 * - `notify.sms` and `notify.email` are hardcoded to `false` (creates link object without contacting customer).
 * - Returns ONLY the 5 allowlisted fields: id, shortUrl, status, referenceId, amount.
 * - Errors are converted via toSafeError() so credentials and auth headers never leak.
 *
 * @param {Object} params
 * @param {number} params.amount - Amount in paise (positive integer).
 * @param {string} [params.currency="INR"] - ISO currency code.
 * @param {string} params.referenceId - Unique reference identifier for idempotency.
 * @param {string} [params.description] - Brief description.
 * @param {string} [params.customerContact] - Customer phone number (optional).
 * @param {string} [params.customerEmail] - Customer email address (optional).
 * @returns {Promise<{
 *   id: string,
 *   shortUrl: string,
 *   status: string,
 *   referenceId: string,
 *   amount: number
 * }>}
 */
async function createPaymentLink({
  amount,
  currency = "INR",
  referenceId,
  description,
  customerContact,
  customerEmail,
} = {}) {
  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error(
      "amount must be a positive integer in paise (e.g. 249900 for Rs 2,499.00)"
    );
    err.isSanitized = true;
    err.reason = "invalid_amount";
    err.httpStatus = 400;
    throw err;
  }

  if (typeof referenceId !== "string" || referenceId.trim() === "") {
    const err = new Error("referenceId is required and cannot be empty");
    err.isSanitized = true;
    err.reason = "missing_reference_id";
    err.httpStatus = 400;
    throw err;
  }

  // When both DEMO_MODE=true and RAZORPAY_MOCK=true:
  // Return deterministic unique synthetic link ID and allowlisted fields without network calls.
  if (process.env.DEMO_MODE === "true" && process.env.RAZORPAY_MOCK === "true") {
    const cleanRef = referenceId.trim();
    const mockId = `plink_DEMO_${cleanRef}`;
    console.log(
      `[razorpayService] MOCK payment link generated for demo: linkId=${mockId}, referenceId=${cleanRef}, amount=${amount}`
    );
    return {
      id: mockId,
      shortUrl: `https://rzp.io/i/demo_${cleanRef}`,
      status: "created",
      referenceId: cleanRef,
      amount,
    };
  }

  const razorpay = getRazorpayClient();

  const payload = {
    amount,
    currency,
    reference_id: referenceId.trim(),
    notify: {
      sms: false,
      email: false,
    },
  };

  if (description && typeof description === "string") {
    payload.description = description.trim();
  }

  const customer = {};
  if (customerContact) customer.contact = customerContact;
  if (customerEmail) customer.email = customerEmail;
  if (Object.keys(customer).length > 0) {
    payload.customer = customer;
  }

  let raw;
  try {
    raw = await razorpay.paymentLink.create(payload);
  } catch (err) {
    throw toSafeError(err);
  }

  return {
    id: raw.id,
    shortUrl: raw.short_url,
    status: raw.status,
    referenceId: raw.reference_id,
    amount: raw.amount,
  };
}

module.exports = {
  getRazorpayClient,
  verifyConnection,
  createOrder,
  createPaymentLink,
  getMissingCredentials,
  describeError,
};


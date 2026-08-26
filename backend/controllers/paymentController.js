const { randomBytes } = require("crypto");

const razorpayService = require("../services/razorpayService");

const PAISE_PER_RUPEE = 100;

/**
 * Validates the incoming rupee amount.
 * Accepts a JSON number or a numeric string; rejects booleans, arrays,
 * objects, empty values, "hello", NaN and Infinity.
 *
 * @returns {{ value: number } | { error: "MISSING" | "INVALID" | "NON_POSITIVE" }}
 */
function parseRupeeAmount(raw) {
  if (raw === undefined || raw === null || raw === "") return { error: "MISSING" };

  let amount;
  if (typeof raw === "number") {
    amount = raw;
  } else if (typeof raw === "string" && raw.trim() !== "") {
    amount = Number(raw);
  } else {
    return { error: "INVALID" };
  }

  if (!Number.isFinite(amount)) return { error: "INVALID" };
  if (amount <= 0) return { error: "NON_POSITIVE" };

  return { value: amount };
}

/**
 * Unique, human-traceable reference. Kept well under Razorpay's 40-char cap.
 * e.g. recover_1756041000000_9f3ac1
 */
function generateReceipt() {
  return `recover_${Date.now()}_${randomBytes(3).toString("hex")}`;
}

/**
 * Maps a sanitized service error onto an HTTP status.
 * Upstream 401/403 is our own misconfiguration, so it must not be reported
 * to the client as their bad request.
 */
function httpStatusFor(safe) {
  if (safe.reason === "invalid_amount") return 400;
  if (safe.reason === "missing_credentials") return 500;

  if (safe.reason === "razorpay_api_error") {
    const upstream = safe.statusCode;
    if (upstream === 401 || upstream === 403) return 500;
    if (upstream >= 400 && upstream < 500) return 400;
    return 502;
  }

  return 502; // network / unknown
}

/**
 * POST /api/payments/orders
 * Body: { "amount": 2499 }   <- rupees
 */
async function createPaymentOrder(req, res) {
  // Express 5 leaves req.body undefined when no JSON body was parsed.
  const body = req.body || {};
  const parsed = parseRupeeAmount(body.amount);

  if (parsed.error === "MISSING") {
    return res.status(400).json({
      success: false,
      message: "'amount' is required and must be a number in rupees",
    });
  }

  if (parsed.error === "INVALID") {
    return res.status(400).json({
      success: false,
      message: "'amount' must be a valid number in rupees",
    });
  }

  if (parsed.error === "NON_POSITIVE") {
    return res.status(400).json({
      success: false,
      message: "'amount' must be greater than zero",
    });
  }

  // Rupees -> paise. Math.round absorbs float error (19.99 * 100 = 1998.999...)
  // and rounds sub-paise precision to the nearest paise.
  const amountInPaise = Math.round(parsed.value * PAISE_PER_RUPEE);
  const receipt = generateReceipt();

  try {
    const order = await razorpayService.createOrder({
      amount: amountInPaise,
      currency: "INR",
      receipt,
    });

    // Explicit allowlist — never spread the raw Razorpay order into the response.
    return res.status(201).json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        status: order.status,
      },
    });
  } catch (err) {
    const safe = razorpayService.describeError(err);
    const status = httpStatusFor(safe);

    console.error(
      `[payments] order creation failed (receipt=${receipt}): ${safe.reason} - ${safe.detail}`
    );

    return res.status(status).json({
      success: false,
      message: "Failed to create Razorpay order",
      reason: safe.reason,
      detail: safe.detail,
    });
  }
}

module.exports = { createPaymentOrder };

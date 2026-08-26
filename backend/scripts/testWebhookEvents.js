/**
 * Repeatable local tests for Razorpay webhook event parsing/classification.
 *
 * Uses a LOCAL DEVELOPMENT SECRET only - never a real Razorpay webhook secret.
 * The payloads below are hand-built samples, NOT captured from Razorpay.
 *
 *   RAZORPAY_WEBHOOK_SECRET=whsec_local_dev_only npm run dev
 *   node scripts/testWebhookEvents.js
 *
 * Optional env:
 *   BASE_URL  (default http://localhost:5000)
 *   LOG_FILE  path to the server log; enables the "invalid signature never
 *             reaches event processing" assertion.
 */
const crypto = require("crypto");
const fs = require("fs");

const {
  parseWebhookBody,
  normalizePaymentEvent,
  isSupportedEvent,
} = require("../services/webhookEvents");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "whsec_local_dev_only";
const LOG_FILE = process.env.LOG_FILE || null;
const URL = `${BASE_URL}/api/webhooks/razorpay`;

// Unique marker: if this ever appears in the server log, an unverified request
// reached event processing.
const FORGED_MARKER = "pay_FORGED_MUST_NEVER_BE_PROCESSED";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function post(body, { signature = undefined, signed = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  const sig = signature !== undefined ? signature : signed ? sign(body) : undefined;
  if (sig !== undefined) headers["X-Razorpay-Signature"] = sig;

  const res = await fetch(URL, { method: "POST", headers, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* ---------- sample payloads (shape only, not real Razorpay data) ---------- */

// email/contact are included deliberately to prove they are NOT extracted
// into the normalized object and NOT logged.
const paymentFailed = JSON.stringify({
  entity: "event",
  account_id: "acc_LOCALTEST",
  event: "payment.failed",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: "pay_TESTFAILED001",
        entity: "payment",
        amount: 249900,
        currency: "INR",
        status: "failed",
        order_id: "order_TESTFAILED001",
        method: "card",
        error_code: "BAD_REQUEST_ERROR",
        error_description: "Payment failed due to insufficient funds",
        error_reason: "payment_failed",
        email: "customer@example.com",
        contact: "+919999999999",
      },
    },
  },
  created_at: 1700000000,
});

const paymentCaptured = JSON.stringify({
  entity: "event",
  event: "payment.captured",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: "pay_TESTCAPTURED001",
        amount: 149900,
        currency: "INR",
        status: "captured",
        order_id: "order_TESTCAPTURED001",
        method: "upi",
      },
    },
  },
});

const unsupportedEvent = JSON.stringify({
  entity: "event",
  event: "order.paid",
  contains: ["order"],
  payload: { order: { entity: { id: "order_TESTUNSUP001", amount: 5000 } } },
});

const forgedFailed = JSON.stringify({
  event: "payment.failed",
  payload: { payment: { entity: { id: FORGED_MARKER, amount: 1, order_id: "order_FORGED" } } },
});

const malformedJson = '{"event": "payment.failed", "payload":';
const jsonScalar = '"just a string"';
const noEventName = JSON.stringify({ entity: "event", payload: { payment: { entity: {} } } });

/* --------------------------------- tests --------------------------------- */

(async () => {
  console.log(`Testing ${URL}\n`);

  console.log("A. Normalization (unit, no server)");
  {
    const parsed = parseWebhookBody(Buffer.from(paymentFailed));
    check("parse ok", parsed.ok, true);
    const n = normalizePaymentEvent(parsed.body);
    check("event", n.event, "payment.failed");
    check("paymentId", n.paymentId, "pay_TESTFAILED001");
    check("orderId", n.orderId, "order_TESTFAILED001");
    check("amount (paise)", n.amount, 249900);
    check("currency", n.currency, "INR");
    check("status", n.status, "failed");
    check("method", n.method, "card");
    check("failureReason", n.failureReason, "Payment failed due to insufficient funds");
    check("no customer email leaked", "email" in n, false);
    check("no customer contact leaked", "contact" in n, false);
    check("exact field set", Object.keys(n).sort(), [
      "amount", "currency", "event", "failureReason", "method", "orderId", "paymentId", "status",
    ]);
  }

  console.log("\nB. Defensive access (malformed shapes must not throw)");
  {
    const shapes = [
      ["empty object", {}],
      ["payload missing", { event: "payment.failed" }],
      ["payload not object", { event: "payment.failed", payload: "nope" }],
      ["payment missing", { event: "payment.failed", payload: {} }],
      ["entity null", { event: "payment.failed", payload: { payment: { entity: null } } }],
      ["entity array", { event: "payment.failed", payload: { payment: { entity: [] } } }],
      ["amount as string", { event: "payment.failed", payload: { payment: { entity: { amount: "249900" } } } }],
      ["amount float", { event: "payment.failed", payload: { payment: { entity: { amount: 1.5 } } } }],
      ["null body", null],
    ];
    for (const [label, body] of shapes) {
      let result;
      try {
        result = normalizePaymentEvent(body);
      } catch (e) {
        result = `THREW: ${e.message}`;
      }
      const allNullish =
        typeof result === "object" &&
        result !== null &&
        [result.paymentId, result.orderId, result.amount, result.currency,
         result.status, result.method, result.failureReason].every((v) => v === null);
      check(`${label} -> no throw, fields null`, allNullish, true);
    }
    // error fallback chain
    const onlyCode = normalizePaymentEvent({
      event: "payment.failed",
      payload: { payment: { entity: { error_code: "GATEWAY_ERROR" } } },
    });
    check("failureReason falls back to error_code", onlyCode.failureReason, "GATEWAY_ERROR");
    const onlyReason = normalizePaymentEvent({
      event: "payment.failed",
      payload: { payment: { entity: { error_reason: "payment_failed", error_code: "X" } } },
    });
    check("error_reason preferred over error_code", onlyReason.failureReason, "payment_failed");
  }

  console.log("\nC. Classification");
  check("payment.failed supported", isSupportedEvent("payment.failed"), true);
  check("payment.captured supported", isSupportedEvent("payment.captured"), true);
  check("order.paid unsupported", isSupportedEvent("order.paid"), false);
  check("undefined unsupported", isSupportedEvent(undefined), false);

  console.log("\nD. HTTP endpoint");
  {
    const r1 = await post(paymentFailed);
    check("1. signed payment.failed -> 200", r1.status, 200);
    check("   event echoed", r1.body?.event, "payment.failed");
    check("   ack shape", r1.body, { success: true, received: true, event: "payment.failed" });

    const r2 = await post(paymentCaptured);
    check("2. signed payment.captured -> 200", r2.status, 200);
    check("   event echoed", r2.body?.event, "payment.captured");

    const r3 = await post(unsupportedEvent);
    check("3. signed unsupported -> 200 (no retry)", r3.status, 200);
    check("   event echoed", r3.body?.event, "order.paid");

    const r4 = await post(malformedJson);
    check("4. signed malformed JSON -> 400", r4.status, 400);
    check("   message", r4.body?.message, "Invalid webhook payload");

    const r4b = await post(jsonScalar);
    check("4b. signed JSON scalar -> 400", r4b.status, 400);

    const r4c = await post(noEventName);
    check("4c. signed, no event name -> 400", r4c.status, 400);

    const r5 = await post(forgedFailed, { signature: "a".repeat(64) });
    check("5. invalid signature -> 401", r5.status, 401);
    check("   message", r5.body?.message, "Invalid webhook signature");

    const r5b = await post(forgedFailed, { signed: false });
    check("5b. no signature header -> 401", r5b.status, 401);
  }

  console.log("\nE. Invalid signature never reached event processing");
  if (LOG_FILE && fs.existsSync(LOG_FILE)) {
    const log = fs.readFileSync(LOG_FILE, "utf8");
    check("forged paymentId absent from log", log.includes(FORGED_MARKER), false);
    check("order_FORGED absent from log", log.includes("order_FORGED"), false);
    check("secret absent from log", log.includes(SECRET), false);
    check("customer email absent from log", log.includes("customer@example.com"), false);
    check("customer contact absent from log", log.includes("+919999999999"), false);
  } else {
    console.log("  skipped (set LOG_FILE=<server log path> to enable)");
  }

  console.log("");
  console.log(failures === 0 ? "PASS: all checks passed" : `FAIL: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})();

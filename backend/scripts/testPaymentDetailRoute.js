/**
 * Focused tests for GET /api/recovery/payments/:razorpayPaymentId
 *
 * Verifies:
 * - 404 on nonexistent payment
 * - PII exclusion: customerEmail / customerContact strictly excluded from response
 * - Razorpay short URL exclusion
 * - Exact allowlisted response shape for both payment and attempts
 * - Newest-first ordering of RecoveryAttempt records
 * - Handling when payment has zero attempts
 * - Clean self-verifying teardown
 *
 * Usage:
 *   node scripts/testPaymentDetailRoute.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const URL = `${BASE_URL}/api/recovery/payments`;

const SYNTHETIC_PREFIX = "pay_SYNTHETIC_DETAIL_";
const PAYMENT_ID_1 = `${SYNTHETIC_PREFIX}001`;
const PAYMENT_ID_NO_ATTEMPTS = `${SYNTHETIC_PREFIX}002`;
const ORDER_ID = "order_SYNTHETIC_DETAIL_001";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${shown}`);
}

async function getPayment(paymentId) {
  const res = await fetch(`${URL}/${paymentId}`);
  const rawText = await res.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {}
  return { status: res.status, body: json, rawText };
}

(async () => {
  console.log("=== Testing Payment Detail Endpoint (GET /api/recovery/payments/:id) ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const initialPaymentCount = await Payment.countDocuments();
  const initialAttemptCount = await RecoveryAttempt.countDocuments();

  // Clean up any leftovers
  await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });
  await RecoveryAttempt.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

  try {
    console.log("--- 1. Nonexistent Payment (404) ---");
    {
      const res = await getPayment("pay_NONEXISTENT_999999");
      check("status is 404", res.status, 404);
      check("success is false", res.body?.success, false);
      check("message is 'Payment not found'", res.body?.message, "Payment not found");
      check("raw response has no 'customerEmail'", res.rawText.includes("customerEmail"), false);
      check("raw response has no 'customerContact'", res.rawText.includes("customerContact"), false);
    }

    console.log("\n--- 2. Valid Payment with Multiple Attempts (Ordering & Allowlist) ---");
    {
      // Seed payment with PII that must NEVER leak to the response
      await Payment.create({
        razorpayPaymentId: PAYMENT_ID_1,
        razorpayOrderId: ORDER_ID,
        amount: 349900,
        currency: "INR",
        status: "failed",
        method: "card",
        failureReason: "Payment declined by bank due to security check",
        customerEmail: "leaked_secret_customer@example.com",
        customerContact: "+919876543210",
      });

      // Older attempt
      const attempt1 = await RecoveryAttempt.create({
        razorpayPaymentId: PAYMENT_ID_1,
        razorpayOrderId: ORDER_ID,
        action: "CREATE_PAYMENT_LINK",
        status: "failed",
        amount: 349900,
        llmReason: "MOCK: Retry recommended",
        llmConfidence: 0.85,
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed",
        executionError: "No contact details available at dispatch time",
        modelVersion: "mock",
        externalReference: null,
        createdAt: new Date(Date.now() - 60000), // 1 min ago
      });

      // Newer attempt
      const attempt2 = await RecoveryAttempt.create({
        razorpayPaymentId: PAYMENT_ID_1,
        razorpayOrderId: ORDER_ID,
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        amount: 349900,
        llmReason: "MOCK: Automated payment link recommended",
        llmConfidence: 0.9,
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed",
        modelVersion: "mock",
        externalReference: "plink_SYNTHETIC_DETAIL_LINK_001",
        createdAt: new Date(Date.now()), // now
      });

      const res = await getPayment(PAYMENT_ID_1);
      check("status is 200", res.status, 200);
      check("success is true", res.body?.success, true);

      // PII checks against raw payload text
      check("raw text has no customerEmail", res.rawText.includes("customerEmail"), false);
      check("raw text has no customerContact", res.rawText.includes("customerContact"), false);
      check("raw text has no leaked email address", res.rawText.includes("leaked_secret_customer@example.com"), false);
      check("raw text has no phone number", res.rawText.includes("+919876543210"), false);
      check("raw text has no short URL or provider payloads", res.rawText.includes("shortUrl"), false);

      // Payment object allowlist assertions
      const paymentObj = res.body?.payment;
      check("payment id matches", paymentObj?.id, PAYMENT_ID_1);
      check("payment orderId matches", paymentObj?.orderId, ORDER_ID);
      check("payment amount matches", paymentObj?.amount, 349900);
      check("payment currency matches", paymentObj?.currency, "INR");
      check("payment status matches", paymentObj?.status, "failed");
      check("payment method matches", paymentObj?.method, "card");
      check("payment failureReason matches", paymentObj?.failureReason, "Payment declined by bank due to security check");
      check("payment exact field set (9 allowlisted keys)", Object.keys(paymentObj).sort(), [
        "amount", "createdAt", "currency", "failureReason", "id", "method", "orderId", "status", "updatedAt"
      ]);

      // Attempts array assertions
      const attempts = res.body?.attempts;
      check("attempts count is 2", attempts?.length, 2);
      check("newest attempt first", attempts[0]?.id, String(attempt2._id));
      check("older attempt second", attempts[1]?.id, String(attempt1._id));

      // Attempt object allowlist assertions
      check("attempt 0 status is 'executed'", attempts[0]?.status, "executed");
      check("attempt 0 externalReference matches", attempts[0]?.externalReference, "plink_SYNTHETIC_DETAIL_LINK_001");
      check("attempt 1 executionError matches", attempts[1]?.executionError, "No contact details available at dispatch time");
      check("attempt exact field set (13 allowlisted keys)", Object.keys(attempts[0]).sort(), [
        "action", "amount", "createdAt", "executionError", "externalReference", "id",
        "llmConfidence", "llmReason", "modelVersion", "policyDecision", "policyReason", "status", "updatedAt"
      ]);
    }

    console.log("\n--- 3. Valid Payment with Zero Attempts ---");
    {
      await Payment.create({
        razorpayPaymentId: PAYMENT_ID_NO_ATTEMPTS,
        razorpayOrderId: "order_SYNTHETIC_DETAIL_002",
        amount: 149900,
        currency: "INR",
        status: "failed",
        method: "upi",
        failureReason: "Customer dropped off",
      });

      const res = await getPayment(PAYMENT_ID_NO_ATTEMPTS);
      check("status is 200", res.status, 200);
      check("success is true", res.body?.success, true);
      check("payment id matches", res.body?.payment?.id, PAYMENT_ID_NO_ATTEMPTS);
      check("attempts is empty array", Array.isArray(res.body?.attempts) && res.body.attempts.length === 0, true);
    }

  } finally {
    console.log("\n--- Teardown & Cleanup ---");
    await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });
    await RecoveryAttempt.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

    const finalPaymentCount = await Payment.countDocuments();
    const finalAttemptCount = await RecoveryAttempt.countDocuments();

    check("Payment count restored cleanly", finalPaymentCount, initialPaymentCount);
    check("RecoveryAttempt count restored cleanly", finalAttemptCount, initialAttemptCount);

    await mongoose.disconnect();
  }

  console.log("\n" + (failures === 0 ? "PASS: All payment detail route assertions passed successfully." : `FAIL: ${failures} assertion(s) failed.`));
  process.exit(failures === 0 ? 0 : 1);
})();

/**
 * Focused tests for GET /api/dashboard
 *
 * Verifies:
 * - All required metrics present in response
 * - Correct values with synthetic data (failed, captured, recovered payments)
 * - Correct recovery attempt counts by status
 * - Recovery rate calculation
 * - Zero-safe behavior when collections are empty
 * - No PII or raw Razorpay payloads in response
 * - Clean self-verifying teardown
 *
 * Usage:
 *   node scripts/testDashboardStats.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const URL = `${BASE_URL}/api/dashboard`;

const SYNTHETIC_PREFIX = "pay_SYNTHETIC_DASH_";
const ORDER_PREFIX = "order_SYNTHETIC_DASH_";
const ATTEMPT_PAYMENT_PREFIX = "pay_SYNTHETIC_DASH_";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${shown}`);
}

function checkType(label, actual, expectedType) {
  const ok = typeof actual === expectedType;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${typeof actual} (expected ${expectedType})`);
}

async function fetchDashboard() {
  const res = await fetch(URL);
  const body = await res.json();
  return { status: res.status, body };
}

(async () => {
  console.log("=== Testing Dashboard Stats (GET /api/dashboard) ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Clean up any leftovers from previous runs
  await Payment.deleteMany({ razorpayPaymentId: { $regex: /^pay_SYNTHETIC_DASH_/ } });
  await RecoveryAttempt.deleteMany({ razorpayPaymentId: { $regex: /^pay_SYNTHETIC_DASH_/ } });

  // --- Test 1: Response structure before any synthetic data ---
  console.log("1. Baseline response structure");
  {
    const { status, body } = await fetchDashboard();
    check("status", status, 200);
    checkType("revenueAtRisk is number", body.revenueAtRisk, "number");
    checkType("revenueRecovered is number", body.revenueRecovered, "number");
    checkType("recoveryRate is number", body.recoveryRate, "number");
    checkType("failedPaymentCount is number", body.failedPaymentCount, "number");
    checkType("recoveredPaymentCount is number", body.recoveredPaymentCount, "number");
    checkType("capturedPaymentCount is number", body.capturedPaymentCount, "number");
    checkType("totalPaymentCount is number", body.totalPaymentCount, "number");
    checkType("totalRecoveryAttemptCount is number", body.totalRecoveryAttemptCount, "number");
    checkType("successfulRecoveryAttemptCount is number", body.successfulRecoveryAttemptCount, "number");
    checkType("pendingReviewCount is number", body.pendingReviewCount, "number");
    checkType("executedAttemptCount is number", body.executedAttemptCount, "number");
    checkType("allowedAttemptCount is number", body.allowedAttemptCount, "number");
    checkType("deniedAttemptCount is number", body.deniedAttemptCount, "number");
    checkType("failedAttemptCount is number", body.failedAttemptCount, "number");
  }

  // --- Test 2: No PII leakage ---
  console.log("\n2. No PII or raw payloads in response");
  {
    const { body } = await fetchDashboard();
    const keys = Object.keys(body);
    check("no customerEmail", keys.includes("customerEmail"), false);
    check("no customerContact", keys.includes("customerContact"), false);
    check("no razorpayPayload", keys.includes("razorpayPayload"), false);
    check("no paymentLinkUrl", keys.includes("paymentLinkUrl"), false);
  }

  // --- Insert synthetic data ---
  console.log("\n3. Inserting synthetic data");
  const syntheticPayments = [
    { razorpayPaymentId: `${SYNTHETIC_PREFIX}F001`, razorpayOrderId: `${ORDER_PREFIX}F001`, amount: 10000, currency: "INR", status: "failed", method: "card", failureReason: "Insufficient funds" },
    { razorpayPaymentId: `${SYNTHETIC_PREFIX}F002`, razorpayOrderId: `${ORDER_PREFIX}F002`, amount: 20000, currency: "INR", status: "failed", method: "netbanking", failureReason: "Bank declined" },
    { razorpayPaymentId: `${SYNTHETIC_PREFIX}R001`, razorpayOrderId: `${ORDER_PREFIX}R001`, amount: 15000, currency: "INR", status: "recovered", method: "card" },
    { razorpayPaymentId: `${SYNTHETIC_PREFIX}C001`, razorpayOrderId: `${ORDER_PREFIX}C001`, amount: 5000, currency: "INR", status: "captured", method: "upi" },
    { razorpayPaymentId: `${SYNTHETIC_PREFIX}C002`, razorpayOrderId: `${ORDER_PREFIX}C002`, amount: 8000, currency: "INR", status: "captured", method: "card" },
  ];

  await Payment.insertMany(syntheticPayments);
  console.log(`  Inserted ${syntheticPayments.length} synthetic payments`);

  const syntheticAttempts = [
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}F001`, action: "CREATE_PAYMENT_LINK", status: "succeeded", amount: 10000, policyDecision: "ALLOW", policyReason: "Passed" },
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}F001`, action: "CREATE_PAYMENT_LINK", status: "allowed", amount: 10000, policyDecision: "ALLOW", policyReason: "Passed" },
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}F002`, action: "CREATE_PAYMENT_LINK", status: "executed", amount: 20000, policyDecision: "ALLOW", policyReason: "Passed" },
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}R001`, action: "STOP", status: "denied", amount: 15000, policyDecision: "DENY", policyReason: "Budget exhausted" },
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}F001`, action: "HUMAN_REVIEW", status: "human_review", amount: 10000, policyDecision: "HUMAN_REVIEW", policyReason: "Needs review" },
    { razorpayPaymentId: `${ATTEMPT_PAYMENT_PREFIX}F002`, action: "CREATE_PAYMENT_LINK", status: "failed", amount: 20000, policyDecision: "ALLOW", policyReason: "Passed", executionError: "Link creation failed" },
  ];

  await RecoveryAttempt.insertMany(syntheticAttempts);
  console.log(`  Inserted ${syntheticAttempts.length} synthetic attempts`);

  // --- Test 4: Verify metrics with known synthetic data ---
  console.log("\n4. Metrics with synthetic data");
  {
    const { status, body } = await fetchDashboard();
    check("status", status, 200);

    // Revenue metrics — the aggregation includes ALL data in the DB, not just synthetic.
    // So we check that the synthetic amounts are included (>= the synthetic totals).
    const hasFailedRevenue = body.revenueAtRisk >= 30000;
    const hasRecoveredRevenue = body.revenueRecovered >= 15000;
    check("revenueAtRisk includes synthetic failed", hasFailedRevenue, true);
    check("revenueRecovered includes synthetic recovered", hasRecoveredRevenue, true);

    // Count metrics
    check("failedPaymentCount >= 2", body.failedPaymentCount >= 2, true);
    check("recoveredPaymentCount >= 1", body.recoveredPaymentCount >= 1, true);
    check("capturedPaymentCount >= 2", body.capturedPaymentCount >= 2, true);
    check("totalPaymentCount >= 5", body.totalPaymentCount >= 5, true);

    // Recovery rate should be > 0 since we have recovered payments
    check("recoveryRate > 0", body.recoveryRate > 0, true);
    check("recoveryRate <= 100", body.recoveryRate <= 100, true);

    // Attempt counts
    check("totalRecoveryAttemptCount >= 6", body.totalRecoveryAttemptCount >= 6, true);
    check("successfulRecoveryAttemptCount >= 1", body.successfulRecoveryAttemptCount >= 1, true);
    check("pendingReviewCount >= 1", body.pendingReviewCount >= 1, true);
    check("executedAttemptCount >= 1", body.executedAttemptCount >= 1, true);
    check("allowedAttemptCount >= 1", body.allowedAttemptCount >= 1, true);
    check("deniedAttemptCount >= 1", body.deniedAttemptCount >= 1, true);
    check("failedAttemptCount >= 1", body.failedAttemptCount >= 1, true);
  }

  // --- Test 5: Recovery rate math check ---
  console.log("\n5. Recovery rate math");
  {
    const { body } = await fetchDashboard();
    const expected = (body.revenueRecovered / (body.revenueRecovered + body.revenueAtRisk)) * 100;
    const expectedRounded = Math.round(expected * 10) / 10;
    check("recoveryRate matches formula", body.recoveryRate, expectedRounded);
  }

  // --- Test 6: Explicit allowlist — only known keys ---
  console.log("\n6. Response contains only allowlisted keys");
  {
    const { body } = await fetchDashboard();
    const allowedKeys = [
      "revenueAtRisk", "revenueRecovered", "recoveryRate",
      "failedPaymentCount", "recoveredPaymentCount", "capturedPaymentCount", "totalPaymentCount",
      "totalRecoveryAttemptCount", "successfulRecoveryAttemptCount", "pendingReviewCount",
      "executedAttemptCount", "allowedAttemptCount", "deniedAttemptCount", "failedAttemptCount",
    ];
    const bodyKeys = Object.keys(body);
    const extraKeys = bodyKeys.filter(k => !allowedKeys.includes(k));
    check("no extra keys", extraKeys.length, 0);
    if (extraKeys.length > 0) {
      console.log(`    Extra keys: ${extraKeys.join(", ")}`);
    }
  }

  // --- Cleanup ---
  console.log("\n7. Cleanup");
  const deletedPayments = await Payment.deleteMany({ razorpayPaymentId: { $regex: /^pay_SYNTHETIC_DASH_/ } });
  const deletedAttempts = await RecoveryAttempt.deleteMany({ razorpayPaymentId: { $regex: /^pay_SYNTHETIC_DASH_/ } });
  console.log(`  Removed ${deletedPayments.deletedCount} synthetic payments`);
  console.log(`  Removed ${deletedAttempts.deletedCount} synthetic attempts`);

  await mongoose.disconnect();

  console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
})();

/**
 * Focused test suite for Safe Demo Reset and Demo Environment Isolation
 *
 * Verifies:
 * 1. GET /api/demo/status reports accurate config including demoPaymentId
 * 2. POST /api/demo/payments/ensure creates or returns synthetic demo payment
 * 3. POST /api/demo/payments/:id/reset rejects NON-demo payments with 403 Forbidden
 * 4. Non-demo payments and non-demo recovery attempts are NEVER mutated or deleted
 * 5. POST /api/demo/payments/:id/reset returns 404 for non-existent payment
 * 6. Valid demo payment resets from recovered to failed with 200 OK
 * 7. Only the demo payment's attempts are deleted
 * 8. Reset is idempotent when called repeatedly
 * 9. Safe and clean teardown
 *
 * Usage:
 *   node scripts/testSafeDemoReset.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const DEMO_PAYMENT_ID = "pay_DEMO_RECOVERAI_001";
const NON_DEMO_PAYMENT_ID = "pay_PROD_TEST_NON_DEMO_999";
const NON_DEMO_ORDER_ID = "order_PROD_TEST_NON_DEMO_999";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(54)} ${shown}`);
}

(async () => {
  console.log("=== Testing Safe Demo Reset & Environment Isolation ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Clean up any test fixtures from prior aborted runs
  await Payment.deleteMany({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
  await RecoveryAttempt.deleteMany({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });

  try {
    // --- Test 1: GET /api/demo/status reports demoPaymentId ---
    console.log("1. GET /api/demo/status");
    {
      const res = await fetch(`${BASE_URL}/api/demo/status`);
      check("status 200", res.status, 200);
      const data = await res.json();
      check("success is true", data.success, true);
      check("enabled is true", data.enabled, true);
      check("demoPaymentId matches", data.demoPaymentId, DEMO_PAYMENT_ID);
    }

    // --- Test 2: POST /api/demo/payments/ensure creates/returns synthetic payment ---
    console.log("\n2. POST /api/demo/payments/ensure (Idempotent seed)");
    {
      const res1 = await fetch(`${BASE_URL}/api/demo/payments/ensure`, {
        method: "POST",
      });
      check("status 200 on first ensure", res1.status, 200);
      const data1 = await res1.json();
      check("success is true", data1.success, true);
      check("returns demo payment id", data1.payment?.id, DEMO_PAYMENT_ID);
      check("is marked isDemo: true", data1.payment?.isDemo, true);

      // Verify in MongoDB
      const doc = await Payment.findOne({ razorpayPaymentId: DEMO_PAYMENT_ID });
      check("MongoDB has isDemo: true", doc?.isDemo, true);

      // Call ensure again to verify idempotency
      const res2 = await fetch(`${BASE_URL}/api/demo/payments/ensure`, {
        method: "POST",
      });
      check("status 200 on second ensure", res2.status, 200);
      const data2 = await res2.json();
      check("idempotent second ensure returns same ID", data2.payment?.id, DEMO_PAYMENT_ID);
    }

    // --- Test 3: Safety Guard - Reject reset of NON-demo payment with 403 Forbidden ---
    console.log("\n3. POST /api/demo/payments/:id/reset rejects non-demo payment (403 Forbidden)");
    {
      // Create non-demo operational payment
      await Payment.create({
        razorpayPaymentId: NON_DEMO_PAYMENT_ID,
        razorpayOrderId: NON_DEMO_ORDER_ID,
        amount: 250000,
        currency: "INR",
        status: "failed",
        failureReason: "Card network timeout",
        isDemo: false,
      });

      // Create an associated attempt
      await RecoveryAttempt.create({
        razorpayPaymentId: NON_DEMO_PAYMENT_ID,
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        channel: "SMS",
        policyDecision: "ALLOW",
        policyReason: "Valid operational recovery attempt",
      });

      const res = await fetch(`${BASE_URL}/api/demo/payments/${NON_DEMO_PAYMENT_ID}/reset`, {
        method: "POST",
      });
      check("rejects non-demo reset with status 403", res.status, 403);
      const data = await res.json();
      check("success is false", data.success, false);
      check("error message indicates non-demo payment", data.message.toLowerCase().includes("demo"), true);

      // Verify DB record was NOT mutated
      const nonDemoPayment = await Payment.findOne({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
      check("non-demo payment status remains failed", nonDemoPayment?.status, "failed");

      // Verify non-demo recovery attempt was NOT deleted
      const nonDemoAttempts = await RecoveryAttempt.find({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
      check("non-demo recovery attempt was preserved", nonDemoAttempts.length, 1);
    }

    // --- Test 4: Reset non-existent payment returns 404 ---
    console.log("\n4. POST /api/demo/payments/:id/reset on nonexistent payment");
    {
      const res = await fetch(`${BASE_URL}/api/demo/payments/pay_NONEXISTENT_99999/reset`, {
        method: "POST",
      });
      check("returns 404", res.status, 404);
    }

    // --- Test 5: Valid Demo Payment Reset ---
    console.log("\n5. Valid Demo Payment Reset (Transitions recovered -> failed and purges demo attempts only)");
    {
      // Mutate demo payment to "recovered"
      await Payment.updateOne(
        { razorpayPaymentId: DEMO_PAYMENT_ID },
        { status: "recovered", recoveredAt: new Date() }
      );

      // Add a demo recovery attempt
      await RecoveryAttempt.create({
        razorpayPaymentId: DEMO_PAYMENT_ID,
        action: "CREATE_PAYMENT_LINK",
        status: "succeeded",
        channel: "SMS",
        policyDecision: "ALLOW",
        policyReason: "Demo rule allow",
      });

      const res = await fetch(`${BASE_URL}/api/demo/payments/${DEMO_PAYMENT_ID}/reset`, {
        method: "POST",
      });
      check("status 200 on demo reset", res.status, 200);
      const data = await res.json();
      check("success is true", data.success, true);
      check("returned payment status is failed", data.payment?.status, "failed");

      // Verify DB status
      const updatedDemo = await Payment.findOne({ razorpayPaymentId: DEMO_PAYMENT_ID });
      check("demo payment in DB is now failed", updatedDemo?.status, "failed");

      // Verify demo attempts were deleted
      const demoAttempts = await RecoveryAttempt.find({ razorpayPaymentId: DEMO_PAYMENT_ID });
      check("demo attempts deleted (count 0)", demoAttempts.length, 0);

      // Verify non-demo attempts are STILL intact
      const nonDemoAttempts = await RecoveryAttempt.find({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
      check("unrelated non-demo attempts remain intact (count 1)", nonDemoAttempts.length, 1);
    }

    // --- Test 6: Idempotency of Demo Reset ---
    console.log("\n6. Reset Idempotency (Resetting an already-failed demo payment)");
    {
      const res = await fetch(`${BASE_URL}/api/demo/payments/${DEMO_PAYMENT_ID}/reset`, {
        method: "POST",
      });
      check("second reset returns status 200", res.status, 200);
      const data = await res.json();
      check("success is true", data.success, true);
      check("payment status remains failed", data.payment?.status, "failed");
    }

  } finally {
    // Cleanup temporary non-demo test fixtures
    await Payment.deleteMany({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
    await RecoveryAttempt.deleteMany({ razorpayPaymentId: NON_DEMO_PAYMENT_ID });
    await mongoose.disconnect();
  }

  console.log(`\n=== Done: ${failures} failure(s) ===`);
  if (failures > 0) {
    process.exit(1);
  }
})();

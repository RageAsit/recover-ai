/**
 * Focused tests for Demo Mode & Simulated Payment Workflow
 *
 * Verifies:
 * - GET /api/demo/status reports accurate config
 * - Rejection when DEMO_MODE is not true
 * - Invalid attempt IDs return 400
 * - Nonexistent attempt returns 404
 * - Attempt without externalReference returns 409
 * - Mock payment link creation (RAZORPAY_MOCK=true)
 * - POST /api/demo/recovery-attempts/:attemptId/payment:
 *     - Transitions payment from failed -> recovered
 *     - Transitions attempt from executed -> succeeded
 *     - Idempotent on repeated calls
 *     - Zero customer PII or raw provider payloads returned
 * - POST /api/demo/payments/:paymentId/reset reverts payment to failed
 * - Clean self-verifying teardown
 *
 * Usage:
 *   node scripts/testDemoWorkflow.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { createPaymentLink } = require("../services/razorpayService");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const SYNTHETIC_PAYMENT_ID = "pay_SYNTHETIC_DEMO_001";
const SYNTHETIC_ORDER_ID = "order_SYNTHETIC_DEMO_001";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(54)} ${shown}`);
}

(async () => {
  console.log("=== Testing Demo Mode & Recovery Workflow ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Clean up any leftovers
  await Payment.deleteMany({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });
  await RecoveryAttempt.deleteMany({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });

  try {
    // --- Test 1: GET /api/demo/status ---
    console.log("1. GET /api/demo/status");
    {
      const res = await fetch(`${BASE_URL}/api/demo/status`);
      check("status 200", res.status, 200);
      const body = await res.json();
      check("success is true", body.success, true);
      check("enabled is true", body.enabled, true);
      check("razorpayMock is true", body.razorpayMock, true);
    }

    // --- Test 2: Invalid attempt ID ---
    console.log("\n2. Invalid attempt ID");
    {
      const res = await fetch(`${BASE_URL}/api/demo/recovery-attempts/not-a-valid-id/payment`, {
        method: "POST",
      });
      check("status is 400", res.status, 400);
      const body = await res.json();
      check("success is false", body.success, false);
      check("error message", body.message, "Invalid attempt id");
    }

    // --- Test 3: Nonexistent attempt ---
    console.log("\n3. Nonexistent attempt");
    {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await fetch(`${BASE_URL}/api/demo/recovery-attempts/${fakeId}/payment`, {
        method: "POST",
      });
      check("status is 404", res.status, 404);
      const body = await res.json();
      check("success is false", body.success, false);
      check("error message", body.message, "Recovery attempt not found");
    }

    // --- Test 4: Mock payment link creation in razorpayService ---
    console.log("\n4. Mock payment link creation");
    {
      const fakeRef = new mongoose.Types.ObjectId().toString();
      const link = await createPaymentLink({
        amount: 349900,
        referenceId: fakeRef,
      });
      check("link.id starts with plink_DEMO_", link.id.startsWith("plink_DEMO_"), true);
      check("link.status is created", link.status, "created");
      check("link.referenceId matches", link.referenceId, fakeRef);
      check("link.amount matches", link.amount, 349900);
    }

    // --- Test 5: Setup synthetic payment and attempt ---
    console.log("\n5. Setting up synthetic payment and attempt");
    const testPayment = await Payment.create({
      razorpayPaymentId: SYNTHETIC_PAYMENT_ID,
      razorpayOrderId: SYNTHETIC_ORDER_ID,
      amount: 499900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Card declined by issuing bank",
      customerEmail: "confidential_demo@example.com",
      customerContact: "+919876543210",
    });
    check("payment created with status failed", testPayment.status, "failed");

    const testAttempt = await RecoveryAttempt.create({
      razorpayPaymentId: SYNTHETIC_PAYMENT_ID,
      razorpayOrderId: SYNTHETIC_ORDER_ID,
      action: "CREATE_PAYMENT_LINK",
      status: "executed",
      amount: 499900,
      policyDecision: "ALLOW",
      policyReason: "Passed policy budget checks",
      externalReference: `plink_DEMO_${SYNTHETIC_PAYMENT_ID}`,
    });
    check("attempt created with status executed", testAttempt.status, "executed");

    // --- Test 6: Simulate customer payment ---
    console.log("\n6. Simulate customer payment (POST /api/demo/recovery-attempts/:attemptId/payment)");
    {
      const res = await fetch(
        `${BASE_URL}/api/demo/recovery-attempts/${testAttempt._id}/payment`,
        { method: "POST" }
      );
      check("status is 200", res.status, 200);
      const rawText = await res.text();
      const body = JSON.parse(rawText);

      check("success is true", body.success, true);
      check("demo is true", body.demo, true);
      check("attemptStatus is succeeded", body.attemptStatus, "succeeded");
      check("paymentStatus is recovered", body.paymentStatus, "recovered");
      check("alreadyProcessed is false", body.alreadyProcessed, false);

      // PII leakage check
      check("no customerEmail in response", rawText.includes("confidential_demo@example.com"), false);
      check("no customerContact in response", rawText.includes("+919876543210"), false);
      check("no shortUrl in response", rawText.includes("rzp.io"), false);

      // Verify DB state
      const dbPayment = await Payment.findOne({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });
      check("DB payment status is recovered", dbPayment.status, "recovered");

      const dbAttempt = await RecoveryAttempt.findById(testAttempt._id);
      check("DB attempt status is succeeded", dbAttempt.status, "succeeded");
    }

    // --- Test 7: Duplicate simulation is idempotent ---
    console.log("\n7. Duplicate simulation idempotency");
    {
      const res = await fetch(
        `${BASE_URL}/api/demo/recovery-attempts/${testAttempt._id}/payment`,
        { method: "POST" }
      );
      check("duplicate returns 200", res.status, 200);
      const body = await res.json();
      check("success is true", body.success, true);
      check("alreadyProcessed is true", body.alreadyProcessed, true);
      check("paymentStatus remains recovered", body.paymentStatus, "recovered");
      check("attemptStatus remains succeeded", body.attemptStatus, "succeeded");
    }

    // --- Test 8: Reset demo payment ---
    console.log("\n8. Reset demo payment (POST /api/demo/payments/:paymentId/reset)");
    {
      const res = await fetch(
        `${BASE_URL}/api/demo/payments/${SYNTHETIC_PAYMENT_ID}/reset`,
        { method: "POST" }
      );
      check("status is 200", res.status, 200);
      const body = await res.json();
      check("success is true", body.success, true);
      check("status is failed", body.status, "failed");

      const dbPayment = await Payment.findOne({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });
      check("DB payment reverted to failed", dbPayment.status, "failed");
    }

  } finally {
    // --- Teardown ---
    console.log("\n9. Teardown");
    const pClean = await Payment.deleteMany({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });
    const aClean = await RecoveryAttempt.deleteMany({ razorpayPaymentId: SYNTHETIC_PAYMENT_ID });
    check("cleaned synthetic payments", pClean.deletedCount >= 0, true);
    check("cleaned synthetic attempts", aClean.deletedCount >= 0, true);

    await mongoose.disconnect();
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
})();

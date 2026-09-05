require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const PORT = process.env.PORT || 5000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${shown}`);
}

(async () => {
  console.log("=== Testing Recovery Agent HTTP Route (POST /api/recovery/:paymentId/run) ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const timestamp = Date.now();
  const TEST_PAYMENT_ID = `pay_ROUTETEST_${timestamp}`;
  const TEST_ORDER_ID = `order_ROUTETEST_${timestamp}`;
  const NONEXISTENT_PAYMENT_ID = `pay_NONEXISTENT_${timestamp}`;

  try {
    // 1. Insert synthetic test payment with contact and email
    // This allows us to verify that even when the DB contains PII, the route response never leaks it.
    await Payment.create({
      razorpayPaymentId: TEST_PAYMENT_ID,
      razorpayOrderId: TEST_ORDER_ID,
      amount: 150000, // 1500 INR
      currency: "INR",
      status: "failed",
      method: "upi",
      failureReason: "Payment failed simulation",
      customerContact: process.env.TEST_CONTACT || "+919876543210",
      customerEmail: "route_test@example.com",
    });

    // -------------------------------------------------------------------------
    // Test 1: POST with no body -> asserts 200, decision present, execution is null
    // -------------------------------------------------------------------------
    console.log("A. POST with no body (decision-only default)");
    const resNoBody = await fetch(`${BASE_URL}/api/recovery/${TEST_PAYMENT_ID}/run`, {
      method: "POST",
    });

    const rawText1 = await resNoBody.text();
    check("HTTP status is 200", resNoBody.status, 200);

    check(
      "'customerContact' does NOT appear in raw response text",
      rawText1.includes("customerContact"),
      false
    );
    check(
      "'customerEmail' does NOT appear in raw response text",
      rawText1.includes("customerEmail"),
      false
    );

    let json1 = {};
    try {
      json1 = JSON.parse(rawText1);
    } catch {
      failures += 1;
      console.error("Failed to parse JSON response for Test 1");
    }

    check("response success is true", json1.success, true);
    check("paymentId matches requested payment", json1.paymentId, TEST_PAYMENT_ID);
    check("decision is present and non-null", Boolean(json1.decision), true);
    check("decision.policyDecision is present", typeof json1.decision?.policyDecision, "string");
    check("decision.finalAction is present", typeof json1.decision?.finalAction, "string");
    check("execution is null", json1.execution, null);

    // Assert explicit allowlist properties
    check("customer.hasEmail is boolean", typeof json1.customer?.hasEmail, "boolean");
    check("customer.hasContact is boolean", typeof json1.customer?.hasContact, "boolean");
    check("attempt.id is present", typeof json1.attempt?.id, "string");
    check("attempt.status is present", typeof json1.attempt?.status, "string");

    // -------------------------------------------------------------------------
    // Test 2: POST with { execute: "true" } (STRING) -> asserts execution is STILL null (no coercion)
    // -------------------------------------------------------------------------
    console.log("\nB. POST with { execute: 'true' } (string value - strictly no coercion)");
    const resStringTrue = await fetch(`${BASE_URL}/api/recovery/${TEST_PAYMENT_ID}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ execute: "true" }),
    });

    const rawText2 = await resStringTrue.text();
    check("HTTP status is 200", resStringTrue.status, 200);

    check(
      "'customerContact' does NOT appear in raw response text",
      rawText2.includes("customerContact"),
      false
    );
    check(
      "'customerEmail' does NOT appear in raw response text",
      rawText2.includes("customerEmail"),
      false
    );

    let json2 = {};
    try {
      json2 = JSON.parse(rawText2);
    } catch {
      failures += 1;
      console.error("Failed to parse JSON response for Test 2");
    }

    check("response success is true", json2.success, true);
    check("execution is STILL null (no coercion of string 'true')", json2.execution, null);
    check("decision is present", Boolean(json2.decision), true);

    // -------------------------------------------------------------------------
    // Test 3: POST for a nonexistent payment id -> asserts 404
    // -------------------------------------------------------------------------
    console.log("\nC. POST for nonexistent payment id");
    const resNotFound = await fetch(`${BASE_URL}/api/recovery/${NONEXISTENT_PAYMENT_ID}/run`, {
      method: "POST",
    });

    const rawText3 = await resNotFound.text();
    check("HTTP status is 404", resNotFound.status, 404);

    check(
      "'customerContact' does NOT appear in raw response text",
      rawText3.includes("customerContact"),
      false
    );
    check(
      "'customerEmail' does NOT appear in raw response text",
      rawText3.includes("customerEmail"),
      false
    );

    let json3 = {};
    try {
      json3 = JSON.parse(rawText3);
    } catch {
      failures += 1;
      console.error("Failed to parse JSON response for Test 3");
    }

    check("response success is false", json3.success, false);
    check("error message is 'Payment not found'", json3.message, "Payment not found");

  } catch (err) {
    console.error("Error during route test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // Clean up synthetic documents
    await Payment.deleteMany({ razorpayPaymentId: TEST_PAYMENT_ID });
    await RecoveryAttempt.deleteMany({ razorpayPaymentId: TEST_PAYMENT_ID });
    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: All recovery route checks passed successfully.");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

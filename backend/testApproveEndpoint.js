require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("./models/Payment");
const RecoveryAttempt = require("./models/RecoveryAttempt");

const PORT = process.env.PORT || 5000;
const BASE_URL = `http://localhost:${PORT}`;
const isApply = process.argv.includes("--apply");

const TS = Date.now();
const PAYMENT_ID_PREFIX = `pay_SYNTHETIC_APPROVE_${TS}`;
const ORDER_ID = `order_SYNTHETIC_APPROVE_${TS}`;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${shown}`);
}

(async () => {
  console.log("=== Testing Dispatch-Only Approve Endpoint (POST /api/recovery/attempts/:id/execute) ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const startPaymentCount = await Payment.countDocuments();
  const startAttemptCount = await RecoveryAttempt.countDocuments();

  const createdPaymentIds = [];
  const createdAttemptIds = [];

  try {
    // -------------------------------------------------------------------------
    // Case A: Malformed ID "not-an-objectid" -> 400
    // -------------------------------------------------------------------------
    console.log("--- Case A: Malformed ID ('not-an-objectid') -> 400 ---");
    {
      const res = await fetch(`${BASE_URL}/api/recovery/attempts/not-an-objectid/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 400", res.status, 400);
      check("success is false", data.success, false);
      check("message is 'Invalid attempt id'", data.message, "Invalid attempt id");
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case B: Valid but nonexistent ObjectId -> 404
    // -------------------------------------------------------------------------
    console.log("--- Case B: Nonexistent ObjectId -> 404 ---");
    {
      const fakeId = new mongoose.Types.ObjectId();
      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${fakeId}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 404", res.status, 404);
      check("success is false", data.success, false);
      check("message is 'Attempt not found'", data.message, "Attempt not found");
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case C: Attempt with policyDecision "DENY" -> 409
    // -------------------------------------------------------------------------
    console.log("--- Case C: policyDecision 'DENY' -> 409 ---");
    {
      const payId = `${PAYMENT_ID_PREFIX}_C`;
      const seededPolicyReason = "Policy denied: maximum attempts exceeded for order";
      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 150000,
          action: "STOP",
          status: "denied",
          policyDecision: "DENY",
          policyReason: seededPolicyReason,
          llmReason: "Card declined by issuer",
          llmConfidence: 0.85,
          modelVersion: "test",
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 409", res.status, 409);
      check("success is false", data.success, false);
      check("message mentions 'not approved'", data.message?.includes("not approved"), true);
      check("policyDecision returned as 'DENY'", data.policyDecision, "DENY");
      check("action returned as 'STOP'", data.action, "STOP");

      const inDb = await RecoveryAttempt.findById(attempt._id).lean();
      check("policyReason byte-identical to seeded", inDb.policyReason, seededPolicyReason);
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case D: Attempt with action "HUMAN_REVIEW" -> 409
    // -------------------------------------------------------------------------
    console.log("--- Case D: action 'HUMAN_REVIEW' -> 409 ---");
    {
      const payId = `${PAYMENT_ID_PREFIX}_D`;
      const seededPolicyReason = "Policy review: order amount exceeds automated threshold";
      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 550000,
          action: "HUMAN_REVIEW",
          status: "human_review",
          policyDecision: "HUMAN_REVIEW",
          policyReason: seededPolicyReason,
          llmReason: "High ticket order with prior chargeback",
          llmConfidence: 0.72,
          modelVersion: "test",
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 409", res.status, 409);
      check("success is false", data.success, false);
      check("message mentions 'not approved'", data.message?.includes("not approved"), true);
      check("policyDecision returned as 'HUMAN_REVIEW'", data.policyDecision, "HUMAN_REVIEW");
      check("action returned as 'HUMAN_REVIEW'", data.action, "HUMAN_REVIEW");

      const inDb = await RecoveryAttempt.findById(attempt._id).lean();
      check("policyReason byte-identical to seeded", inDb.policyReason, seededPolicyReason);
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case E: Attempt already status "executed" -> 200 alreadyExecuted: true
    // -------------------------------------------------------------------------
    console.log("--- Case E: Already executed attempt -> 200 alreadyExecuted: true ---");
    {
      const payId = `${PAYMENT_ID_PREFIX}_E`;
      const seededRef = "plink_seed_existing_001";
      const seededPolicyReason = "Policy checks passed: already executed seed";
      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 250000,
          action: "CREATE_PAYMENT_LINK",
          status: "executed",
          externalReference: seededRef,
          policyDecision: "ALLOW",
          policyReason: seededPolicyReason,
          llmReason: "Customer strong recovery candidate",
          llmConfidence: 0.92,
          modelVersion: "test",
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 200", res.status, 200);
      check("success is true", data.success, true);
      check("alreadyExecuted is true", data.alreadyExecuted, true);
      check("attemptId matches", data.attemptId, String(attempt._id));
      check("status is 'executed'", data.status, "executed");
      check("externalReference unchanged", data.externalReference, seededRef);

      const inDb = await RecoveryAttempt.findById(attempt._id).lean();
      check("DB externalReference unchanged", inDb.externalReference, seededRef);
      check("policyReason byte-identical to seeded", inDb.policyReason, seededPolicyReason);
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case F: Attempt created 90 minutes ago -> 409 stale, ageMinutes ~90
    // -------------------------------------------------------------------------
    console.log("--- Case F: Stale approval (90 mins ago) -> 409 stale ---");
    {
      const payId = `${PAYMENT_ID_PREFIX}_F`;
      const seededPolicyReason = "Policy checks passed: stale test seed";
      const staleTime = new Date(Date.now() - 90 * 60 * 1000);
      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 199900,
          action: "CREATE_PAYMENT_LINK",
          status: "allowed",
          policyDecision: "ALLOW",
          policyReason: seededPolicyReason,
          llmReason: "Transient bank network timeout",
          llmConfidence: 0.88,
          modelVersion: "test",
          createdAt: staleTime,
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 409", res.status, 409);
      check("success is false", data.success, false);
      check("message mentions 'stale'", data.message?.includes("stale"), true);
      check("ageMinutes is approximately 90", Math.abs(data.ageMinutes - 90) <= 2, true);

      const inDb = await RecoveryAttempt.findById(attempt._id).lean();
      check("policyReason byte-identical to seeded", inDb.policyReason, seededPolicyReason);
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Case G: Valid fresh attempt whose Payment is "captured" -> 200 success: false
    // -------------------------------------------------------------------------
    console.log("--- Case G: Payment status 'captured' -> 200 success: false (Step 33 guard) ---");
    {
      const payId = `${PAYMENT_ID_PREFIX}_G`;
      const seededPolicyReason = "Policy checks passed: captured guard seed";

      await Payment.create({
        razorpayPaymentId: payId,
        razorpayOrderId: ORDER_ID,
        amount: 150000,
        currency: "INR",
        status: "captured",
        method: "card",
        customerContact: "+919999999999",
        customerEmail: "captured@example.com",
      });
      createdPaymentIds.push(payId);

      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 150000,
          action: "CREATE_PAYMENT_LINK",
          status: "allowed",
          policyDecision: "ALLOW",
          policyReason: seededPolicyReason,
          llmReason: "Test retry candidate",
          llmConfidence: 0.9,
          modelVersion: "test",
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const res = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const data = await res.json();
      check("HTTP status is 200", res.status, 200);
      check("success is false", data.success, false);
      check("attemptId matches", data.attemptId, String(attempt._id));
      check("status is 'failed'", data.status, "failed");
      check("executionError mentions 'no longer at risk'", data.executionError?.includes("no longer at risk"), true);
      check("executionError contains 'captured'", data.executionError?.includes("captured"), true);

      const inDb = await RecoveryAttempt.findById(attempt._id).lean();
      check("DB status updated to 'failed'", inDb.status, "failed");
      check("policyReason byte-identical to seeded", inDb.policyReason, seededPolicyReason);
    }
    console.log("");

    // -------------------------------------------------------------------------
    // Cases H & I: Real dispatch guarded by --apply
    // -------------------------------------------------------------------------
    if (!isApply) {
      console.log("--- Cases H & I: Real Dispatch (Skipped - requires --apply) ---");
      console.log("  [info] --apply not specified: skipped Case H (live dispatch) and Case I (idempotency check)");
    } else {
      console.log("--- Case H: Real Dispatch with --apply ---");
      const payId = `${PAYMENT_ID_PREFIX}_H`;
      const seededPolicyReason = "Policy checks passed: real dispatch test";

      await Payment.create({
        razorpayPaymentId: payId,
        razorpayOrderId: ORDER_ID,
        amount: 10000, // Rs 100.00
        currency: "INR",
        status: "failed",
        method: "card",
        customerContact: process.env.TEST_CUSTOMER_CONTACT || process.env.TEST_CONTACT || "+919876543210",
        customerEmail: process.env.TEST_CUSTOMER_EMAIL || "test@example.com",
      });
      createdPaymentIds.push(payId);

      const [attempt] = await RecoveryAttempt.insertMany([
        {
          razorpayPaymentId: payId,
          razorpayOrderId: ORDER_ID,
          amount: 10000,
          action: "CREATE_PAYMENT_LINK",
          status: "allowed",
          policyDecision: "ALLOW",
          policyReason: seededPolicyReason,
          llmReason: "Candidate for live recovery link",
          llmConfidence: 0.95,
          modelVersion: "test",
        },
      ]);
      createdAttemptIds.push(attempt._id);

      const resH = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const dataH = await resH.json();
      check("HTTP status is 200", resH.status, 200);
      check("success is true", dataH.success, true);
      check("alreadyExecuted is false", dataH.alreadyExecuted, false);
      check("externalReference starts with 'plink_'", dataH.externalReference?.startsWith("plink_"), true);
      check("link.linkId is present", Boolean(dataH.link?.linkId), true);
      check("link.status is present", Boolean(dataH.link?.status), true);

      const inDbH = await RecoveryAttempt.findById(attempt._id).lean();
      check("DB status is 'executed'", inDbH.status, "executed");
      check("DB externalReference matches response", inDbH.externalReference, dataH.externalReference);
      check("policyReason byte-identical to seeded", inDbH.policyReason, seededPolicyReason);
      console.log("");

      console.log("--- Case I: Immediate duplicate POST (idempotency check) ---");
      const resI = await fetch(`${BASE_URL}/api/recovery/attempts/${attempt._id}/execute`, {
        method: "POST",
      });
      const dataI = await resI.json();
      check("HTTP status is 200", resI.status, 200);
      check("success is true", dataI.success, true);
      check("alreadyExecuted is true", dataI.alreadyExecuted, true);
      check("externalReference IDENTICAL to Case H", dataI.externalReference, dataH.externalReference);

      const inDbI = await RecoveryAttempt.findById(attempt._id).lean();
      check("DB status remains 'executed'", inDbI.status, "executed");
      check("DB externalReference remains identical", inDbI.externalReference, dataH.externalReference);
      check("policyReason byte-identical to seeded", inDbI.policyReason, seededPolicyReason);
    }
    console.log("");

  } catch (err) {
    console.error("Error during approve endpoint test execution:", err);
    process.exitCode = 1;
  } finally {
    console.log("--- Teardown & Cleanup ---");
    if (createdPaymentIds.length > 0) {
      await Payment.deleteMany({ razorpayPaymentId: { $in: createdPaymentIds } });
    }
    if (createdAttemptIds.length > 0) {
      await RecoveryAttempt.deleteMany({ _id: { $in: createdAttemptIds } });
    }

    const endPaymentCount = await Payment.countDocuments();
    const endAttemptCount = await RecoveryAttempt.countDocuments();

    check("Payment count restored", endPaymentCount, startPaymentCount);
    check("RecoveryAttempt count restored", endAttemptCount, startAttemptCount);

    await mongoose.disconnect();

    console.log("");
    if (failures === 0 && !process.exitCode) {
      console.log("PASS: All approve endpoint assertions passed successfully.");
    } else {
      console.error(`FAIL: ${failures} assertion(s) failed.`);
      process.exitCode = 1;
    }
  }
})();

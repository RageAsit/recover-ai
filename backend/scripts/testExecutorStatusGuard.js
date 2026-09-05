require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { executePaymentLinkForAttempt } = require("../services/recoveryExecutor");

const TS = Date.now();
const PAYMENT_IDS = {
  A: `pay_SYNTHETIC_GUARD_A_${TS}`,
  B: `pay_SYNTHETIC_GUARD_B_${TS}`,
  C: `pay_SYNTHETIC_GUARD_C_${TS}`,
  D: `pay_SYNTHETIC_GUARD_D_${TS}`,
  E: `pay_SYNTHETIC_GUARD_E_${TS}`,
};
const ORDER_ID = `order_SYNTHETIC_GUARD_${TS}`;
const SEEDED_POLICY_REASON = "Policy checks passed: seeded for executor guard test";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${shown}`);
}

function makeAttemptData(paymentId, overrides = {}) {
  return {
    razorpayPaymentId: paymentId,
    razorpayOrderId: ORDER_ID,
    amount: 100000,
    action: "CREATE_PAYMENT_LINK",
    status: "allowed",
    policyDecision: "ALLOW",
    policyReason: SEEDED_POLICY_REASON,
    llmReason: "Test LLM reason",
    llmConfidence: 0.9,
    modelVersion: "test",
    ...overrides,
  };
}

function makePaymentData(paymentId, status, overrides = {}) {
  return {
    razorpayPaymentId: paymentId,
    razorpayOrderId: ORDER_ID,
    amount: 100000,
    status,
    method: "card",
    ...overrides,
  };
}

(async () => {
  console.log("=== Executor Live Payment Status Guard Tests ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Record starting counts for self-verifying teardown
  const startPaymentCount = await Payment.countDocuments();
  const startAttemptCount = await RecoveryAttempt.countDocuments();

  const createdPaymentIds = [];
  const createdAttemptIds = [];

  try {
    // =========================================================================
    // CASE A: Payment status "captured" -> refuses dispatch
    // =========================================================================
    console.log("--- Case A: Payment status 'captured' ---");
    {
      const payment = await Payment.create(makePaymentData(PAYMENT_IDS.A, "captured", {
        customerContact: "+919999999999",
        customerEmail: "test@example.com",
      }));
      createdPaymentIds.push(PAYMENT_IDS.A);

      const attempt = await RecoveryAttempt.create(makeAttemptData(PAYMENT_IDS.A));
      createdAttemptIds.push(attempt._id);

      const result = await executePaymentLinkForAttempt({ attempt });

      const updated = await RecoveryAttempt.findById(attempt._id).lean();
      check("returns null", result, null);
      check("attempt status is 'failed'", updated.status, "failed");
      check("executionError mentions 'no longer at risk'",
        updated.executionError?.includes("no longer at risk"), true);
      check("executionError contains 'captured'",
        updated.executionError?.includes("captured"), true);
      check("policyReason UNCHANGED", updated.policyReason, SEEDED_POLICY_REASON);
      check("status is NOT 'executed' (no Razorpay call)", updated.status !== "executed", true);
    }
    console.log("");

    // =========================================================================
    // CASE B: Payment status "recovered" -> refuses dispatch
    // The Payment model enum is [failed, captured, recovered]. "authorized" is
    // not a valid stored status. "recovered" is a second non-failed status that
    // exercises the same guard path as "captured" but with a different value.
    // =========================================================================
    console.log("--- Case B: Payment status 'recovered' ---");
    {
      const payment = await Payment.create(makePaymentData(PAYMENT_IDS.B, "recovered", {
        customerContact: "+919999999999",
      }));
      createdPaymentIds.push(PAYMENT_IDS.B);

      const attempt = await RecoveryAttempt.create(makeAttemptData(PAYMENT_IDS.B));
      createdAttemptIds.push(attempt._id);

      const result = await executePaymentLinkForAttempt({ attempt });

      const updated = await RecoveryAttempt.findById(attempt._id).lean();
      check("returns null", result, null);
      check("attempt status is 'failed'", updated.status, "failed");
      check("executionError mentions 'no longer at risk'",
        updated.executionError?.includes("no longer at risk"), true);
      check("executionError contains 'recovered'",
        updated.executionError?.includes("recovered"), true);
      check("policyReason UNCHANGED", updated.policyReason, SEEDED_POLICY_REASON);
      check("status is NOT 'executed' (no Razorpay call)", updated.status !== "executed", true);
    }
    console.log("");

    // =========================================================================
    // CASE C: No Payment document at all -> refuses dispatch
    // =========================================================================
    console.log("--- Case C: No Payment document ---");
    {
      // No payment created for PAYMENT_IDS.C
      const attempt = await RecoveryAttempt.create(makeAttemptData(PAYMENT_IDS.C));
      createdAttemptIds.push(attempt._id);

      const result = await executePaymentLinkForAttempt({ attempt });

      const updated = await RecoveryAttempt.findById(attempt._id).lean();
      check("returns null", result, null);
      check("attempt status is 'failed'", updated.status, "failed");
      check("executionError is 'Payment record not found at dispatch time'",
        updated.executionError, "Payment record not found at dispatch time");
      check("policyReason UNCHANGED", updated.policyReason, SEEDED_POLICY_REASON);
      check("status is NOT 'executed' (no Razorpay call)", updated.status !== "executed", true);
    }
    console.log("");

    // =========================================================================
    // CASE D: Already-executed guard fires BEFORE status guard
    // Payment is "failed" with contacts, but attempt already has status "executed"
    // and an externalReference -> nothing changes, proves guard ordering.
    // =========================================================================
    console.log("--- Case D: Already-executed attempt (guard ordering) ---");
    {
      const payment = await Payment.create(makePaymentData(PAYMENT_IDS.D, "failed", {
        customerContact: "+919999999999",
        customerEmail: "test@example.com",
      }));
      createdPaymentIds.push(PAYMENT_IDS.D);

      const seededRef = "plink_guard_test_existing";
      const attempt = await RecoveryAttempt.create(makeAttemptData(PAYMENT_IDS.D, {
        status: "executed",
        externalReference: seededRef,
      }));
      createdAttemptIds.push(attempt._id);

      const result = await executePaymentLinkForAttempt({ attempt });

      const updated = await RecoveryAttempt.findById(attempt._id).lean();
      check("returns null", result, null);
      check("status STILL 'executed' (not downgraded)", updated.status, "executed");
      check("externalReference STILL the seeded value", updated.externalReference, seededRef);
      check("policyReason UNCHANGED", updated.policyReason, SEEDED_POLICY_REASON);
    }
    console.log("");

    // =========================================================================
    // CASE E: Payment "failed", no contact details -> existing no-contact path
    // =========================================================================
    console.log("--- Case E: Payment 'failed', no contact details ---");
    {
      const payment = await Payment.create(makePaymentData(PAYMENT_IDS.E, "failed"));
      // No customerContact or customerEmail on this payment
      createdPaymentIds.push(PAYMENT_IDS.E);

      const attempt = await RecoveryAttempt.create(makeAttemptData(PAYMENT_IDS.E));
      createdAttemptIds.push(attempt._id);

      const result = await executePaymentLinkForAttempt({ attempt });

      const updated = await RecoveryAttempt.findById(attempt._id).lean();
      check("returns null", result, null);
      check("attempt status is 'failed'", updated.status, "failed");
      check("executionError is 'No contact details available at dispatch time'",
        updated.executionError, "No contact details available at dispatch time");
      check("policyReason UNCHANGED", updated.policyReason, SEEDED_POLICY_REASON);
      check("status is NOT 'executed' (no Razorpay call)", updated.status !== "executed", true);
    }
    console.log("");

  } finally {
    // =========================================================================
    // SELF-VERIFYING TEARDOWN
    // =========================================================================
    console.log("--- Teardown ---");

    // Delete only what this test created
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
    if (failures === 0) {
      console.log("PASS: All executor status guard assertions passed. Zero Razorpay calls made.");
    } else {
      console.log(`FAIL: ${failures} assertion(s) failed.`);
      process.exitCode = 1;
    }
  }
})();

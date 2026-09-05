// CRITICAL: Ensure mock mode is active so test execution consumes 0 LLM quota
process.env.LLM_MOCK = "true";

require("dotenv").config();

// Ensure test limits are deterministic
if (!process.env.RECOVERY_MAX_ATTEMPTS) {
  process.env.RECOVERY_MAX_ATTEMPTS = "2";
}
if (!process.env.RECOVERY_MAX_AMOUNT_PAISE) {
  process.env.RECOVERY_MAX_AMOUNT_PAISE = "400000";
}

const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { runRecoveryAgent } = require("../services/recoveryAgent");
const { executePaymentLinkForAttempt } = require("../services/recoveryExecutor");

const isApply = process.argv.includes("--apply");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(58)} ${shown}`);
}

(async () => {
  console.log(`=== Test Recovery Executor [${isApply ? "LIVE (--apply)" : "DRY RUN (no payment link created)"}] ===\n`);

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  // Dry run: abort if process.env.TEST_CONTACT is unset or empty
  if (!process.env.TEST_CONTACT || process.env.TEST_CONTACT.trim() === "") {
    console.error("ABORT: TEST_CONTACT environment variable is absent or empty. Do not hardcode a phone number.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const timestamp = Date.now();
  const DRY_PAYMENT_ID = `pay_EXEC_DRY_${timestamp}`;
  const DRY_ORDER_ID = `order_EXEC_DRY_${timestamp}`;

  const NO_CONTACT_PAYMENT_ID = `pay_EXEC_NOCONTACT_${timestamp}`;
  const NO_CONTACT_ORDER_ID = `order_EXEC_NOCONTACT_${timestamp}`;

  const LIVE_PAYMENT_ID = `pay_EXEC_LIVE_${timestamp}`;
  const LIVE_ORDER_ID = `order_EXEC_LIVE_${timestamp}`;

  const createdPaymentIds = [];
  const createdOrderIds = [];

  try {
    // 1. Dry run: synthetic failed Payment WITH customerContact from process.env.TEST_CONTACT
    console.log("A. Dry Run: Decision-Only Pipeline (execute: false)");
    await Payment.create({
      razorpayPaymentId: DRY_PAYMENT_ID,
      razorpayOrderId: DRY_ORDER_ID,
      amount: 50000, // 500 INR (well under policy limit)
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Insufficient funds",
      customerContact: process.env.TEST_CONTACT.trim(),
    });
    createdPaymentIds.push(DRY_PAYMENT_ID);
    createdOrderIds.push(DRY_ORDER_ID);

    const dryRunResult = await runRecoveryAgent(DRY_PAYMENT_ID, { execute: false });

    check("dry run policyDecision is ALLOW", dryRunResult?.policyResult?.policyDecision, "ALLOW");
    check("dry run attempt status is 'allowed'", dryRunResult?.attempt?.status, "allowed");
    check("dry run execution is null", dryRunResult?.execution, null);
    check("dry run externalReference is unset", dryRunResult?.attempt?.externalReference ?? null, null);

    const dryAttemptCount = await RecoveryAttempt.countDocuments({
      razorpayOrderId: DRY_ORDER_ID,
    });
    check("exactly 1 attempt row exists in database", dryAttemptCount, 1);

    const dryDbAttempt = await RecoveryAttempt.findById(dryRunResult.attempt._id).lean();
    check("database attempt status is 'allowed'", dryDbAttempt?.status, "allowed");
    check("database attempt externalReference is unset", dryDbAttempt?.externalReference ?? null, null);

    // 2. Both-absent path: payment with NO customerContact and NO customerEmail
    console.log("\nB. Both-Absent Contact Boundary Check (Second check at money boundary)");
    await Payment.create({
      razorpayPaymentId: NO_CONTACT_PAYMENT_ID,
      razorpayOrderId: NO_CONTACT_ORDER_ID,
      amount: 25000, // under the limit
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Payment failed",
      // customerContact and customerEmail both omitted
    });
    createdPaymentIds.push(NO_CONTACT_PAYMENT_ID);
    createdOrderIds.push(NO_CONTACT_ORDER_ID);

    // Simulate an attempt where policy somehow reached execution with status "allowed"
    const forcedAttempt = await RecoveryAttempt.create({
      razorpayPaymentId: NO_CONTACT_PAYMENT_ID,
      razorpayOrderId: NO_CONTACT_ORDER_ID,
      amount: 25000,
      action: "CREATE_PAYMENT_LINK",
      policyDecision: "ALLOW",
      policyReason: "Initial allowed reason from policy engine",
      status: "allowed",
    });

    const noContactResult = await executePaymentLinkForAttempt({
      attempt: forcedAttempt,
    });

    check("executor returns null when both contacts absent", noContactResult, null);

    // 3. C. policyReason survives a dispatch failure
    console.log("\nC. policyReason survives a dispatch failure");
    const updatedNoContactAttempt = await RecoveryAttempt.findById(forcedAttempt._id).lean();
    check("status is 'failed'", updatedNoContactAttempt?.status, "failed");
    check(
      "policyReason is STILL the original policy engine text, unchanged",
      updatedNoContactAttempt?.policyReason,
      "Initial allowed reason from policy engine"
    );
    check(
      "executionError is a non-empty string",
      typeof updatedNoContactAttempt?.executionError === "string" &&
        updatedNoContactAttempt.executionError.length > 0,
      true
    );
    check("externalReference remains unset", updatedNoContactAttempt?.externalReference ?? null, null);

    // 4. D. Already-executed attempts are not re-dispatched
    console.log("\nD. Already-executed attempts are not re-dispatched");
    const ALREADY_PAYMENT_ID = `pay_EXEC_ALREADY_${timestamp}`;
    const ALREADY_ORDER_ID = `order_EXEC_ALREADY_${timestamp}`;

    const alreadyExecutedAttempt = await RecoveryAttempt.create({
      razorpayPaymentId: ALREADY_PAYMENT_ID,
      razorpayOrderId: ALREADY_ORDER_ID,
      amount: 25000,
      action: "CREATE_PAYMENT_LINK",
      policyDecision: "ALLOW",
      policyReason: "Policy checks passed",
      status: "executed",
      externalReference: "plink_ALREADYDONE",
    });
    createdPaymentIds.push(ALREADY_PAYMENT_ID);
    createdOrderIds.push(ALREADY_ORDER_ID);

    const alreadyExecResult = await executePaymentLinkForAttempt({
      attempt: alreadyExecutedAttempt,
    });

    check("it returns null", alreadyExecResult, null);

    const dbAlreadyExecuted = await RecoveryAttempt.findById(alreadyExecutedAttempt._id).lean();
    check("status in the database is STILL 'executed'", dbAlreadyExecuted?.status, "executed");
    check(
      "externalReference in the database is STILL 'plink_ALREADYDONE'",
      dbAlreadyExecuted?.externalReference,
      "plink_ALREADYDONE"
    );
    check("executionError was NOT set", dbAlreadyExecuted?.executionError ?? null, null);

    // 5. Live execution with --apply
    if (!isApply) {
      console.log("\n--------------------------------------------------------------------------------");
      console.log("DRY RUN COMPLETE: No live payment links created.");
      console.log("To run live Razorpay link creation, pass --apply flag.");
      console.log("--------------------------------------------------------------------------------");
    } else {
      console.log("\nE. Live Execution Mode (--apply)");
      await Payment.create({
        razorpayPaymentId: LIVE_PAYMENT_ID,
        razorpayOrderId: LIVE_ORDER_ID,
        amount: 100, // 100 paise = 1 INR
        currency: "INR",
        status: "failed",
        method: "card",
        failureReason: "Payment failure simulation",
        customerContact: process.env.TEST_CONTACT.trim(),
      });
      createdPaymentIds.push(LIVE_PAYMENT_ID);
      createdOrderIds.push(LIVE_ORDER_ID);

      const liveRunResult = await runRecoveryAgent(LIVE_PAYMENT_ID, { execute: true });

      const liveDbAttempt = await RecoveryAttempt.findById(liveRunResult?.attempt?._id).lean();
      check("attempt status in the database is 'executed'", liveDbAttempt?.status, "executed");
      check(
        "externalReference is non-empty starting with 'plink_'",
        typeof liveDbAttempt?.externalReference === "string" &&
          liveDbAttempt.externalReference.startsWith("plink_"),
        true
      );
      check(
        "execution.shortUrl starts with 'https://'",
        typeof liveRunResult?.execution?.shortUrl === "string" &&
          liveRunResult.execution.shortUrl.startsWith("https://"),
        true
      );

      // Idempotency test: call executePaymentLinkForAttempt AGAIN with that same attempt
      console.log("\nF. Idempotency Check (re-executing same attempt)");
      const secondExecResult = await executePaymentLinkForAttempt({
        attempt: liveRunResult.attempt,
      });
      check("re-execution does NOT succeed (returns null)", secondExecResult, null);

      const secondDbAttempt = await RecoveryAttempt.findById(liveRunResult.attempt._id).lean();
      check("status in the database is STILL 'executed'", secondDbAttempt?.status, "executed");
      check(
        "externalReference in the database is STILL preserved",
        secondDbAttempt?.externalReference,
        liveDbAttempt?.externalReference
      );
      check("executionError was NOT set", secondDbAttempt?.executionError ?? null, null);
    }
  } catch (err) {
    console.error("Error during test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // Clean up every document created
    if (createdPaymentIds.length > 0) {
      await Payment.deleteMany({ razorpayPaymentId: { $in: createdPaymentIds } });
      await RecoveryAttempt.deleteMany({ razorpayPaymentId: { $in: createdPaymentIds } });
    }
    if (createdOrderIds.length > 0) {
      await RecoveryAttempt.deleteMany({ razorpayOrderId: { $in: createdOrderIds } });
    }
    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: testRecoveryExecutor completed successfully.");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

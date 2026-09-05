// CRITICAL: Ensure mock mode is active so test execution consumes 0 API quota
process.env.LLM_MOCK = "true";

require("dotenv").config();

// Ensure test limits are deterministic
process.env.RECOVERY_MAX_ATTEMPTS = "2";
process.env.RECOVERY_MAX_AMOUNT_PAISE = "500000";

const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { runRecoveryAgent } = require("../services/recoveryAgent");

const TEST_PAYMENT_ID = "pay_SYNTHETIC_AGENT_001";
const TEST_ORDER_ID = "order_SYNTHETIC_AGENT_001";

const TEST_PAYMENT_HR = "pay_SYNTHETIC_AGENT_HR_001";
const TEST_ORDER_HR = "order_SYNTHETIC_AGENT_HR_001";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(56)} ${shown}`);
}

(async () => {
  console.log("Testing runRecoveryAgent Pipeline & Budget-Consuming Attempt Tracking (Mock Mode)\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // Clean up any stale data from prior runs
    await Payment.deleteMany({ razorpayPaymentId: { $in: [TEST_PAYMENT_ID, TEST_PAYMENT_HR] } });
    await RecoveryAttempt.deleteMany({ razorpayOrderId: { $in: [TEST_ORDER_ID, TEST_ORDER_HR] } });

    // 1. Insert synthetic Payment
    await Payment.create({
      razorpayPaymentId: TEST_PAYMENT_ID,
      razorpayOrderId: TEST_ORDER_ID,
      amount: 77700,
      currency: "INR",
      status: "failed",
      method: "netbanking",
      failureReason: "Declined by bank",
      customerContact: "+919876543210",
    });

    console.log("A. Run 1: First Attempt (attemptsForOrder = 0)");
    const run1 = await runRecoveryAgent(TEST_PAYMENT_ID);
    check("run 1 policyDecision is ALLOW", run1.policyResult.policyDecision, "ALLOW");
    check("run 1 finalAction is CREATE_PAYMENT_LINK", run1.policyResult.finalAction, "CREATE_PAYMENT_LINK");
    check("run 1 attempt status is 'allowed'", run1.attempt.status, "allowed");
    check("run 1 attemptsForOrder was 0", run1.recoveryHistory.attemptsForOrder, 0);

    console.log("\nB. Run 2: Second Attempt (attemptsForOrder = 1, under limit of 2)");
    const run2 = await runRecoveryAgent(TEST_PAYMENT_ID);
    check("run 2 policyDecision is ALLOW", run2.policyResult.policyDecision, "ALLOW");
    check("run 2 attempt status is 'allowed'", run2.attempt.status, "allowed");
    check("run 2 attemptsForOrder was 1", run2.recoveryHistory.attemptsForOrder, 1);

    console.log("\nC. Run 3: Third Attempt (attemptsForOrder = 2, reaches limit of 2)");
    const run3 = await runRecoveryAgent(TEST_PAYMENT_ID);
    check("run 3 policyDecision is DENY", run3.policyResult.policyDecision, "DENY");
    check("run 3 finalAction is STOP", run3.policyResult.finalAction, "STOP");
    check("run 3 attempt status is 'denied'", run3.attempt.status, "denied");
    check("run 3 attemptsForOrder was 2", run3.recoveryHistory.attemptsForOrder, 2);

    const namesAttemptLimit =
      typeof run3.policyResult.policyReason === "string" &&
      run3.policyResult.policyReason.toLowerCase().includes("attempt");
    check("run 3 policyReason names attempt limit", namesAttemptLimit, true);

    console.log("\nD. Persistence Verification After 3 Runs");
    const totalAttemptsRun3 = await RecoveryAttempt.countDocuments({ razorpayOrderId: TEST_ORDER_ID });
    check("exactly 3 RecoveryAttempt docs persisted for order", totalAttemptsRun3, 3);

    console.log("\nE. Denials do not inflate the counter (Run 4)");
    const run4 = await runRecoveryAgent(TEST_PAYMENT_ID);
    check("run 4 policyDecision is DENY", run4.policyResult.policyDecision, "DENY");
    check("run 4 recoveryHistory.attemptsForOrder is still 2", run4.recoveryHistory.attemptsForOrder, 2);
    check("run 4 recoveryHistory.agentRunsForOrder is 3", run4.recoveryHistory.agentRunsForOrder, 3);
    check("run 4 attempt status is 'denied'", run4.attempt.status, "denied");

    const totalAttemptsRun4 = await RecoveryAttempt.countDocuments({ razorpayOrderId: TEST_ORDER_ID });
    check("exactly 4 RecoveryAttempt rows now exist for order", totalAttemptsRun4, 4);

    console.log("\nF. Human review does not burn the attempt budget");
    await Payment.create({
      razorpayPaymentId: TEST_PAYMENT_HR,
      razorpayOrderId: TEST_ORDER_HR,
      amount: 600000, // 6000 INR > 5000 INR limit
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Card limit exceeded",
      customerContact: "+919876543210",
    });

    const hrRun1 = await runRecoveryAgent(TEST_PAYMENT_HR);
    check("hrRun 1 policyDecision is HUMAN_REVIEW", hrRun1.policyResult.policyDecision, "HUMAN_REVIEW");
    check("hrRun 1 attempt status is 'human_review'", hrRun1.attempt.status, "human_review");
    check("hrRun 1 attemptsForOrder was 0", hrRun1.recoveryHistory.attemptsForOrder, 0);

    const hrRun2 = await runRecoveryAgent(TEST_PAYMENT_HR);
    check("hrRun 2 attemptsForOrder is STILL 0", hrRun2.recoveryHistory.attemptsForOrder, 0);
    check("hrRun 2 agentRunsForOrder is 1", hrRun2.recoveryHistory.agentRunsForOrder, 1);
    check("hrRun 2 policyDecision is HUMAN_REVIEW again", hrRun2.policyResult.policyDecision, "HUMAN_REVIEW");
    check("hrRun 2 attempt status is 'human_review'", hrRun2.attempt.status, "human_review");

    const totalHrAttempts = await RecoveryAttempt.countDocuments({ razorpayOrderId: TEST_ORDER_HR });
    check("exactly 2 RecoveryAttempt rows exist for HR order", totalHrAttempts, 2);

  } catch (err) {
    console.error("Error during recovery agent test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // Clean up test documents
    await Payment.deleteMany({ razorpayPaymentId: { $in: [TEST_PAYMENT_ID, TEST_PAYMENT_HR] } });
    await RecoveryAttempt.deleteMany({ razorpayOrderId: { $in: [TEST_ORDER_ID, TEST_ORDER_HR] } });
    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: runRecoveryAgent budget-consuming attempt limits verified successfully.");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

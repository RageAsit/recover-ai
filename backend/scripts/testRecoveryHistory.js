require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { getRecoveryHistory } = require("../services/recoveryHistory");

const ORDER_ID = "order_SYNTHETIC_HISTTEST_001";
const PAYMENT_MAIN = "pay_SYNTHETIC_HISTTEST_MAIN";
const PAYMENT_ALT1 = "pay_SYNTHETIC_HISTTEST_ALT1";
const PAYMENT_ALT2 = "pay_SYNTHETIC_HISTTEST_ALT2";

const ALL_PAYMENTS = [PAYMENT_MAIN, PAYMENT_ALT1, PAYMENT_ALT2];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

(async () => {
  console.log("Testing getRecoveryHistory & Order-level Attempt Tracking\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // Clean up any stale data first
    await Payment.deleteMany({ razorpayPaymentId: { $in: ALL_PAYMENTS } });
    await RecoveryAttempt.deleteMany({ razorpayOrderId: ORDER_ID });

    // 1. Insert one synthetic Payment with an orderId
    await Payment.create({
      razorpayPaymentId: PAYMENT_MAIN,
      razorpayOrderId: ORDER_ID,
      amount: 249900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Insufficient funds",
    });

    // 2. Insert THREE RecoveryAttempt docs sharing that orderId with different paymentIds
    const now = Date.now();

    // Oldest attempt on PAYMENT_MAIN
    await RecoveryAttempt.create({
      razorpayPaymentId: PAYMENT_MAIN,
      razorpayOrderId: ORDER_ID,
      action: "RETRY",
      status: "executed",
      policyDecision: "ALLOW",
      createdAt: new Date(now - 30000),
    });

    // Middle attempt on PAYMENT_ALT1
    await RecoveryAttempt.create({
      razorpayPaymentId: PAYMENT_ALT1,
      razorpayOrderId: ORDER_ID,
      action: "STOP",
      status: "denied",
      policyDecision: "DENY",
      createdAt: new Date(now - 20000),
    });

    // Most recent attempt on PAYMENT_ALT2
    const mostRecentDate = new Date(now - 10000);
    await RecoveryAttempt.create({
      razorpayPaymentId: PAYMENT_ALT2,
      razorpayOrderId: ORDER_ID,
      action: "CREATE_PAYMENT_LINK",
      status: "pending",
      policyDecision: "ALLOW",
      createdAt: mostRecentDate,
    });

    // 3. Query history for PAYMENT_MAIN
    const history = await getRecoveryHistory(PAYMENT_MAIN);

    console.log("=== ASSEMBLED RECOVERY HISTORY ===");
    console.log(JSON.stringify(history, null, 2));
    console.log("");

    console.log("A. Order vs Payment Attempt Tracking");
    check("attemptsForPayment is 1", history?.attemptsForPayment, 1);
    check("attemptsForOrder is 2 (excluding denied attempt)", history?.attemptsForOrder, 2);
    check("agentRunsForOrder is 3 (total raw rows)", history?.agentRunsForOrder, 3);

    console.log("\nB. Most Recent Attempt Metadata");
    check("lastAction reflects most recent doc", history?.lastAction, "CREATE_PAYMENT_LINK");
    check("lastPolicyDecision reflects most recent doc", history?.lastPolicyDecision, "ALLOW");
    check("lastAttemptAt is ISO date string", Boolean(history?.lastAttemptAt), true);

    console.log("\nC. Status Counts");
    check("executedCount is 1", history?.executedCount, 1);
    check("deniedCount is 1", history?.deniedCount, 1);
    check("succeededCount is 0", history?.succeededCount, 0);
    check("humanReviewCount is 0", history?.humanReviewCount, 0);

  } catch (err) {
    console.error("Error during test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // Teardown created documents
    await Payment.deleteMany({ razorpayPaymentId: { $in: ALL_PAYMENTS } });
    await RecoveryAttempt.deleteMany({ razorpayOrderId: ORDER_ID });
    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: getRecoveryHistory verified successfully.");
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

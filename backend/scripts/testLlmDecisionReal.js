require("dotenv").config();
// Explicitly disable mock mode
process.env.LLM_MOCK = "false";

const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const { buildPaymentContext } = require("../services/paymentContext");
const { getRecoveryHistory } = require("../services/recoveryHistory");
const { getRecoveryRecommendation } = require("../services/llmDecision");
const { evaluateRecovery } = require("../services/policyEngine");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

(async () => {
  const isSpend = process.argv.includes("--spend");

  console.log(`=== Real LLM Decision Test [${isSpend ? "LIVE CALL (--spend)" : "DRY RUN (no API call)"}] ===\n`);

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // 1. Locate target payment with amount 77700
    const payment = await Payment.findOne({ amount: 77700 }).lean();
    if (!payment) {
      console.error("ABORT: Payment with amount 77700 not found in database.");
      process.exitCode = 1;
      return;
    }

    console.log(`Found target payment: ${payment.razorpayPaymentId} (amount: ${payment.amount} paise, orderId: ${payment.razorpayOrderId || "none"})\n`);

    // 2. Build context and recovery history
    const context = await buildPaymentContext(payment.razorpayPaymentId);
    const recoveryHistory = await getRecoveryHistory(payment.razorpayPaymentId);

    console.log("=== 1. ASSEMBLED PAYMENT CONTEXT ===");
    console.log(JSON.stringify(context, null, 2));
    console.log("");

    console.log("=== 2. ASSEMBLED RECOVERY HISTORY ===");
    console.log(JSON.stringify(recoveryHistory, null, 2));
    console.log("");

    if (!isSpend) {
      console.log("--------------------------------------------------------------------------------");
      console.log("DRY RUN MODE: No API request was sent.");
      console.log("To execute the live Gemini API call and spend 1 of 20 daily free-tier requests, run:");
      console.log("  node scripts/testLlmDecisionReal.js --spend");
      console.log("--------------------------------------------------------------------------------");
      return;
    }

    console.log("⚠️  WARNING: Executing REAL Gemini API call (consuming 1 of 20 daily requests)...\n");

    // 3. Invoke real LLM decision
    const recommendation = await getRecoveryRecommendation({ context, recoveryHistory });

    console.log("=== 3. RAW LLM RECOMMENDATION ===");
    console.log(JSON.stringify(recommendation, null, 2));
    console.log("");

    // 4. Evaluate through deterministic policy engine
    const policyResult = evaluateRecovery({ context, recoveryHistory, recommendation });

    console.log("=== 4. DETERMINISTIC POLICY RESULT ===");
    console.log(JSON.stringify(policyResult, null, 2));
    console.log("");

    // 5. Assertions
    console.log("=== 5. INTEGRATION ASSERTIONS ===");

    const isMockReason =
      typeof recommendation.reason === "string" &&
      recommendation.reason.startsWith("MOCK:");
    check("recommendation is NOT from mock mode", isMockReason, false);

    const validModelVersion =
      typeof recommendation.modelVersion === "string" &&
      recommendation.modelVersion.trim().length > 0;
    check("modelVersion is a non-null string", validModelVersion, true);

    const validResponseId = recommendation.responseId !== null;
    check("responseId is non-null", validResponseId, true);

    check("policyDecision is valid string", ["ALLOW", "DENY", "HUMAN_REVIEW"].includes(policyResult.policyDecision), true);
    check("finalAction is valid action string", typeof policyResult.finalAction === "string" && policyResult.finalAction.length > 0, true);

    console.log("");
    if (failures === 0) {
      console.log("PASS: Real LLM recommendation and policy evaluation completed successfully.");
    } else {
      console.error(`FAIL: ${failures} check(s) failed.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Error during real LLM decision test:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

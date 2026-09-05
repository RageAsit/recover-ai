// CRITICAL: Ensure mock mode is active so test execution consumes 0 API quota
process.env.LLM_MOCK = "true";

const { getRecoveryRecommendation } = require("../services/llmDecision");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

(async () => {
  console.log("Testing getRecoveryRecommendation in Mock Mode\n");

  const sampleContext = {
    payment: {
      razorpayPaymentId: "pay_TEST_LLM_001",
      razorpayOrderId: "order_TEST_LLM_001",
      amount: 249900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Payment failed due to insufficient funds",
      createdAt: new Date().toISOString(),
    },
    customer: {
      identifierType: "contact",
      hasEmail: true,
      hasContact: true,
      priorFailed: 0,
      priorSuccessful: 0,
      totalSuccessfulAmount: 0,
    },
    order: {
      attemptsOnThisOrder: 1,
    },
  };

  const sampleHistory = {
    attemptsForPayment: 0,
    attemptsForOrder: 0,
    executedCount: 0,
    succeededCount: 0,
    deniedCount: 0,
    lastAttemptAt: null,
    lastAction: null,
    lastPolicyDecision: null,
  };

  const recommendation = await getRecoveryRecommendation({
    context: sampleContext,
    recoveryHistory: sampleHistory,
  });

  console.log("=== RETURNED RECOMMENDATION ===");
  console.log(JSON.stringify(recommendation, null, 2));
  console.log("");

  console.log("A. Field Existence & Types");
  check("action is CREATE_PAYMENT_LINK", recommendation.action, "CREATE_PAYMENT_LINK");
  check("confidence is number", typeof recommendation.confidence, "number");
  check("confidence value is 0.75", recommendation.confidence, 0.75);
  check("requiresHumanReview is boolean", typeof recommendation.requiresHumanReview, "boolean");
  check("requiresHumanReview is false", recommendation.requiresHumanReview, false);
  check("reason is string", typeof recommendation.reason, "string");
  check("modelVersion is string", typeof recommendation.modelVersion, "string");
  check("modelVersion is 'mock'", recommendation.modelVersion, "mock");
  check("responseId is string", typeof recommendation.responseId, "string");

  console.log("\nB. Mock Identifier & Safety Checks");
  const startsWithMock =
    typeof recommendation.reason === "string" && recommendation.reason.startsWith("MOCK:");
  check("reason starts with 'MOCK:'", startsWithMock, true);

  const responseIdMock =
    typeof recommendation.responseId === "string" && recommendation.responseId.startsWith("mock-");
  check("responseId starts with 'mock-'", responseIdMock, true);

  console.log("");
  if (failures === 0) {
    console.log("PASS: getRecoveryRecommendation mock mode verified successfully.");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

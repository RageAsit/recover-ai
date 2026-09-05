const { evaluateRecovery } = require("../services/policyEngine");

// Set deterministic test environment variables
process.env.RECOVERY_MAX_ATTEMPTS = "2";
process.env.RECOVERY_MAX_AMOUNT_PAISE = "500000"; // 5,000 INR

function makeContext(overrides = {}) {
  return {
    payment: {
      razorpayPaymentId: "pay_TEST001",
      razorpayOrderId: "order_TEST001",
      amount: 249900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Insufficient funds",
      createdAt: new Date(),
      ...(overrides.payment || {}),
    },
    customer: {
      identifierType: "email",
      hasEmail: true,
      hasContact: false,
      priorFailed: 0,
      priorSuccessful: 0,
      totalSuccessfulAmount: 0,
      ...(overrides.customer || {}),
    },
    order: {
      attemptsOnThisOrder: 1,
      ...(overrides.order || {}),
    },
  };
}

function makeHistory(overrides = {}) {
  return {
    attemptsForPayment: 0,
    attemptsForOrder: 0,
    executedCount: 0,
    succeededCount: 0,
    deniedCount: 0,
    lastAttemptAt: null,
    lastAction: null,
    lastPolicyDecision: null,
    ...overrides,
  };
}

function makeRecommendation(overrides = {}) {
  return {
    action: "CREATE_PAYMENT_LINK",
    confidence: 0.85,
    reason: "Customer failed on card due to funds; sending link for alternate method.",
    requiresHumanReview: false,
    ...overrides,
  };
}

const testCases = [
  {
    name: "Rule 1: captured payment -> DENY / STOP",
    input: {
      context: makeContext({ payment: { status: "captured" } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation(),
    },
    expected: { policyDecision: "DENY", finalAction: "STOP" },
  },
  {
    name: "Rule 1: recovered payment -> DENY / STOP",
    input: {
      context: makeContext({ payment: { status: "recovered" } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation(),
    },
    expected: { policyDecision: "DENY", finalAction: "STOP" },
  },
  {
    name: "Rule 1 (Asymmetry): requiresHumanReview false on already-captured payment still yields DENY",
    input: {
      context: makeContext({ payment: { status: "captured" } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ requiresHumanReview: false }),
    },
    expected: { policyDecision: "DENY", finalAction: "STOP" },
  },
  {
    name: "Rule 2: attemptsForOrder 2 reaches limit -> DENY / STOP",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory({ attemptsForOrder: 2, attemptsForPayment: 1 }),
      recommendation: makeRecommendation(),
    },
    expected: { policyDecision: "DENY", finalAction: "STOP" },
  },
  {
    name: "Rule 2 (Order vs Payment): attemptsForPayment 5 alone with attemptsForOrder 1 yields ALLOW",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory({ attemptsForPayment: 5, attemptsForOrder: 1 }),
      recommendation: makeRecommendation({ action: "RETRY" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "RETRY" },
  },
  {
    name: "Rule 3: CREATE_PAYMENT_LINK with neither email nor contact -> DENY / NO_ACTION",
    input: {
      context: makeContext({ customer: { hasEmail: false, hasContact: false } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "CREATE_PAYMENT_LINK" }),
    },
    expected: { policyDecision: "DENY", finalAction: "NO_ACTION" },
  },
  {
    name: "Rule 3: CREATE_PAYMENT_LINK with hasEmail=true -> ALLOW / CREATE_PAYMENT_LINK",
    input: {
      context: makeContext({ customer: { hasEmail: true, hasContact: false } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "CREATE_PAYMENT_LINK" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "CREATE_PAYMENT_LINK" },
  },
  {
    name: "Rule 3: CREATE_PAYMENT_LINK with hasContact=true -> ALLOW / CREATE_PAYMENT_LINK",
    input: {
      context: makeContext({ customer: { hasEmail: false, hasContact: true } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "CREATE_PAYMENT_LINK" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "CREATE_PAYMENT_LINK" },
  },
  {
    name: "Rule 4: recommendation requiresHumanReview=true -> HUMAN_REVIEW / HUMAN_REVIEW",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ requiresHumanReview: true, action: "RETRY" }),
    },
    expected: { policyDecision: "HUMAN_REVIEW", finalAction: "HUMAN_REVIEW" },
  },
  {
    name: "Rule 5: payment amount > 500000 paise -> HUMAN_REVIEW / HUMAN_REVIEW",
    input: {
      context: makeContext({ payment: { amount: 600000 } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "RETRY" }),
    },
    expected: { policyDecision: "HUMAN_REVIEW", finalAction: "HUMAN_REVIEW" },
  },
  {
    name: "Rule 5 (Confidence Ignored): confidence 0.99 with amount over limit still yields HUMAN_REVIEW",
    input: {
      context: makeContext({ payment: { amount: 600000 } }),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ confidence: 0.99, action: "CREATE_PAYMENT_LINK" }),
    },
    expected: { policyDecision: "HUMAN_REVIEW", finalAction: "HUMAN_REVIEW" },
  },
  {
    name: "Rule 7 (Confidence Ignored): confidence 0.01 with clean context yields ALLOW",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ confidence: 0.01, action: "RETRY" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "RETRY" },
  },
  {
    name: "Rule 6: unrecognized action -> DENY / NO_ACTION",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "UNKNOWN_ACTION_DO_NOTHING" }),
    },
    expected: { policyDecision: "DENY", finalAction: "NO_ACTION" },
  },
  {
    name: "Rule 7: standard STOP recommendation -> ALLOW / STOP",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "STOP" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "STOP" },
  },
  {
    name: "Rule 7: standard NO_ACTION recommendation -> ALLOW / NO_ACTION",
    input: {
      context: makeContext(),
      recoveryHistory: makeHistory(),
      recommendation: makeRecommendation({ action: "NO_ACTION" }),
    },
    expected: { policyDecision: "ALLOW", finalAction: "NO_ACTION" },
  },
];

console.log("Testing Deterministic Policy Engine (Pure Synchronous)\n");

let failures = 0;

for (const tc of testCases) {
  const result = evaluateRecovery(tc.input);
  const ok =
    result.policyDecision === tc.expected.policyDecision &&
    result.finalAction === tc.expected.finalAction;

  if (!ok) {
    failures++;
  }

  const statusStr = ok ? "ok  " : "FAIL";
  console.log(`  ${statusStr} ${tc.name.padEnd(80)}`);
  console.log(`       Expected: decision=${tc.expected.policyDecision}, finalAction=${tc.expected.finalAction}`);
  console.log(`       Actual:   decision=${result.policyDecision}, finalAction=${result.finalAction}, reason="${result.policyReason}"\n`);
}

// Environment validation test cases
console.log("Checking Environment Validation & Abort Behavior:");
{
  const origAttempts = process.env.RECOVERY_MAX_ATTEMPTS;
  const origAmount = process.env.RECOVERY_MAX_AMOUNT_PAISE;

  // 1. Missing RECOVERY_MAX_ATTEMPTS
  delete process.env.RECOVERY_MAX_ATTEMPTS;
  let threwMissingAttempts = false;
  try {
    evaluateRecovery({ context: makeContext(), recoveryHistory: makeHistory(), recommendation: makeRecommendation() });
  } catch (e) {
    threwMissingAttempts = e.message.includes("RECOVERY_MAX_ATTEMPTS is missing");
  }
  const ok1 = threwMissingAttempts;
  if (!ok1) failures++;
  console.log(`  ${ok1 ? "ok  " : "FAIL"} Aborts when RECOVERY_MAX_ATTEMPTS is missing`);

  // 2. Non-positive RECOVERY_MAX_AMOUNT_PAISE
  process.env.RECOVERY_MAX_ATTEMPTS = "2";
  process.env.RECOVERY_MAX_AMOUNT_PAISE = "-50";
  let threwInvalidAmount = false;
  try {
    evaluateRecovery({ context: makeContext(), recoveryHistory: makeHistory(), recommendation: makeRecommendation() });
  } catch (e) {
    threwInvalidAmount = e.message.includes("RECOVERY_MAX_AMOUNT_PAISE is missing or not a positive integer");
  }
  const ok2 = threwInvalidAmount;
  if (!ok2) failures++;
  console.log(`  ${ok2 ? "ok  " : "FAIL"} Aborts when RECOVERY_MAX_AMOUNT_PAISE is non-positive`);

  // Restore env
  process.env.RECOVERY_MAX_ATTEMPTS = origAttempts;
  process.env.RECOVERY_MAX_AMOUNT_PAISE = origAmount;
}

console.log("");
if (failures === 0) {
  console.log("PASS: All policy engine rules and guardrails verified successfully.");
  process.exit(0);
} else {
  console.error(`FAIL: ${failures} test case(s) failed.`);
  process.exit(1);
}

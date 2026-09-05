const { buildPaymentContext } = require("./paymentContext");
const { getRecoveryHistory } = require("./recoveryHistory");
const { getRecoveryRecommendation } = require("./llmDecision");
const { evaluateRecovery } = require("./policyEngine");
const { executePaymentLinkForAttempt } = require("./recoveryExecutor");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const DECISION_TO_STATUS = Object.freeze({
  ALLOW: "allowed",
  DENY: "denied",
  HUMAN_REVIEW: "human_review",
});

/**
 * Orchestrates the end-to-end recovery decision pipeline for a failed payment,
 * persists the decision audit record as a RecoveryAttempt, and optionally dispatches
 * approved actions (such as creating a Razorpay payment link).
 *
 * Pipeline sequence:
 * 1. buildPaymentContext: Aggregates non-PII payment and customer metadata.
 * 2. getRecoveryHistory: Aggregates previous attempts across payment and order.
 * 3. getRecoveryRecommendation: Obtains recommendation from LLM (or mock).
 * 4. evaluateRecovery: Applies deterministic policy rules to determine final action.
 * 5. RecoveryAttempt.create: Persists audit record of recommendation and policy decision.
 * 6. (Optional) executePaymentLinkForAttempt: Dispatches payment link creation if requested and allowed.
 *
 * @param {string} razorpayPaymentId
 * @param {Object} [options={}]
 * @param {boolean} [options.execute=false]
 * @returns {Promise<{
 *   context: Object,
 *   recoveryHistory: Object,
 *   recommendation: Object,
 *   policyResult: Object,
 *   attempt: Object,
 *   execution: Object|null
 * } | null>}
 */
async function runRecoveryAgent(razorpayPaymentId, options = {}) {
  const { execute = false } = options;

  // 1. Build payment context
  const context = await buildPaymentContext(razorpayPaymentId);
  if (!context) {
    return null;
  }

  // 2. Query recovery history
  const recoveryHistory = await getRecoveryHistory(razorpayPaymentId);

  // 3. Solicit LLM recommendation (mock or real)
  const recommendation = await getRecoveryRecommendation({
    context,
    recoveryHistory,
  });

  // 4. Evaluate through deterministic policy guardrails
  const policyResult = evaluateRecovery({
    context,
    recoveryHistory,
    recommendation,
  });

  // 5. Persist audit trail record (RecoveryAttempt)
  const status = DECISION_TO_STATUS[policyResult.policyDecision];
  if (!status) {
    throw new Error(
      `Unmapped policy decision "${policyResult.policyDecision}" in recoveryAgent. An unmapped decision on a money path must fail loudly.`
    );
  }

  const attempt = await RecoveryAttempt.create({
    razorpayPaymentId: context.payment.razorpayPaymentId,
    razorpayOrderId: context.payment.razorpayOrderId ?? undefined,
    amount: context.payment.amount,
    action: policyResult.finalAction,
    llmReason: recommendation.reason,
    llmConfidence: recommendation.confidence,
    policyDecision: policyResult.policyDecision,
    policyReason: policyResult.policyReason,
    modelVersion: recommendation.modelVersion,
    responseId: recommendation.responseId,
    status,
  });

  // PERSIST THE ATTEMPT FIRST, THEN EXECUTE. Never the other way around.
  // If we executed first and the database write then failed, we would have contacted a
  // customer with no record of it, and the next run would not know. Persist-first
  // means a mid-way crash leaves an "allowed" row with no link - which burns an
  // attempt but never double-sends.
  let execution = null;
  if (
    execute === true &&
    policyResult.policyDecision === "ALLOW" &&
    policyResult.finalAction === "CREATE_PAYMENT_LINK"
  ) {
    execution = await executePaymentLinkForAttempt({ attempt });
  }

  return {
    context,
    recoveryHistory,
    recommendation,
    policyResult,
    attempt,
    execution,
  };
}

module.exports = {
  runRecoveryAgent,
};


const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

// Exclusion list rationale: over-counting loses revenue, under-counting sends unauthorized
// payment links to customers, so an unrecognized future status must count by default.
const EXCLUDED_BUDGET_STATUSES = Object.freeze(["denied", "human_review"]);

/**
 * Retrieves historical recovery attempts for a given payment.
 *
 * CRITICAL GUARDRAIL DESIGN:
 * `attemptsForOrder` counts only budget-consuming recovery attempts (excluding
 * status "denied" and "human_review" which did not take recovery action).
 * A Razorpay retry issues a NEW payment ID while maintaining the SAME order ID.
 * If history were counted only by payment ID, multiple consecutive failures on
 * the same order would appear as unrelated first attempts, preventing attempt-limit
 * guardrails from ever triggering.
 *
 * `agentRunsForOrder` records the total raw invocation count across all statuses
 * for audit and debugging purposes.
 *
 * @param {string} razorpayPaymentId
 * @returns {Promise<{
 *   attemptsForPayment: number,
 *   attemptsForOrder: number,
 *   agentRunsForOrder: number,
 *   executedCount: number,
 *   succeededCount: number,
 *   deniedCount: number,
 *   humanReviewCount: number,
 *   lastAttemptAt: Date|null,
 *   lastAction: string|null,
 *   lastPolicyDecision: string|null
 * } | null>}
 */
async function getRecoveryHistory(razorpayPaymentId) {
  const payment = await Payment.findOne({ razorpayPaymentId }).lean();
  if (!payment) {
    return null;
  }

  let attempts;
  let attemptsForPayment = 0;
  let attemptsForOrder = 0;
  let agentRunsForOrder = 0;

  if (payment.razorpayOrderId) {
    attempts = await RecoveryAttempt.find({
      razorpayOrderId: payment.razorpayOrderId,
    })
      .sort({ createdAt: -1 })
      .lean();

    agentRunsForOrder = attempts.length;
    attemptsForOrder = attempts.filter(
      (a) => !EXCLUDED_BUDGET_STATUSES.includes(a.status)
    ).length;
    attemptsForPayment = attempts.filter(
      (a) => a.razorpayPaymentId === razorpayPaymentId && !EXCLUDED_BUDGET_STATUSES.includes(a.status)
    ).length;
  } else {
    // If the payment has no razorpayOrderId, fallback to querying by payment ID.
    // In this case, attemptsForOrder is set equal to attemptsForPayment.
    attempts = await RecoveryAttempt.find({
      razorpayPaymentId,
    })
      .sort({ createdAt: -1 })
      .lean();

    agentRunsForOrder = attempts.length;
    attemptsForPayment = attempts.filter(
      (a) => !EXCLUDED_BUDGET_STATUSES.includes(a.status)
    ).length;
    attemptsForOrder = attemptsForPayment;
  }

  let executedCount = 0;
  let succeededCount = 0;
  let deniedCount = 0;
  let humanReviewCount = 0;

  for (const attempt of attempts) {
    if (attempt.status === "executed" || attempt.status === "succeeded") {
      executedCount++;
    }
    if (attempt.status === "succeeded") {
      succeededCount++;
    }
    if (attempt.status === "denied") {
      deniedCount++;
    }
    if (attempt.status === "human_review") {
      humanReviewCount++;
    }
  }

  const mostRecent = attempts[0] || null;
  const lastAttemptAt = mostRecent?.createdAt ?? null;
  const lastAction = mostRecent?.action ?? null;
  const lastPolicyDecision = mostRecent?.policyDecision ?? null;

  return {
    attemptsForPayment,
    attemptsForOrder,
    agentRunsForOrder,
    executedCount,
    succeededCount,
    deniedCount,
    humanReviewCount,
    lastAttemptAt,
    lastAction,
    lastPolicyDecision,
  };
}

module.exports = { getRecoveryHistory };


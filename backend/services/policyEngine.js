const VALID_ACTIONS = Object.freeze([
  "CREATE_PAYMENT_LINK",
  "RETRY",
  "NO_ACTION",
  "STOP",
  "HUMAN_REVIEW",
]);

/**
 * Validates and retrieves policy limits from environment variables.
 * Aborts if either is missing or not a positive integer.
 */
function getPolicyLimits() {
  const maxAttemptsRaw = process.env.RECOVERY_MAX_ATTEMPTS;
  const maxAmountRaw = process.env.RECOVERY_MAX_AMOUNT_PAISE;

  const maxAttempts = Number(maxAttemptsRaw);
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error(
      `ABORT: RECOVERY_MAX_ATTEMPTS is missing or not a positive integer (got ${JSON.stringify(maxAttemptsRaw)})`
    );
  }

  const maxAmountPaise = Number(maxAmountRaw);
  if (!Number.isInteger(maxAmountPaise) || maxAmountPaise <= 0) {
    throw new Error(
      `ABORT: RECOVERY_MAX_AMOUNT_PAISE is missing or not a positive integer (got ${JSON.stringify(maxAmountRaw)})`
    );
  }

  return { maxAttempts, maxAmountPaise };
}

/**
 * Pure synchronous deterministic policy engine evaluating recovery recommendations.
 *
 * TWO HARD RULES:
 * 1. NEVER read recommendation.confidence. It is an uncalibrated number the model
 *    invented because the schema demanded one. It must not influence money.
 * 2. requiresHumanReview is ASYMMETRIC: true may escalate (rule 4), false must
 *    never de-escalate. It cannot skip rules 1, 2, 3 or 5.
 *
 * EVALUATION ORDER (FIRST MATCH WINS):
 * 1. context.payment.status is "captured" or "recovered"
 *      -> DENY, finalAction: "STOP" (money already arrived)
 * 2. recoveryHistory.attemptsForOrder >= RECOVERY_MAX_ATTEMPTS
 *      -> DENY, finalAction: "STOP" (use attemptsForOrder, NEVER attemptsForPayment - retries get new payment ids on the same order)
 * 3. recommendation.action is CREATE_PAYMENT_LINK and BOTH context.customer.hasEmail and .hasContact are false
 *      -> DENY, finalAction: "NO_ACTION" (cannot send a link to nobody)
 * 4. recommendation.requiresHumanReview is true
 *      -> HUMAN_REVIEW, finalAction: "HUMAN_REVIEW"
 * 5. context.payment.amount > RECOVERY_MAX_AMOUNT_PAISE
 *      -> HUMAN_REVIEW, finalAction: "HUMAN_REVIEW"
 * 6. recommendation.action is not one of the five valid actions
 *      -> DENY, finalAction: "NO_ACTION"
 * 7. otherwise
 *      -> ALLOW, finalAction = recommendation.action
 *
 * @param {{
 *   context: Object,
 *   recoveryHistory: Object,
 *   recommendation: { action: string, confidence?: number, reason?: string, requiresHumanReview?: boolean }
 * }} params
 * @returns {{
 *   policyDecision: "ALLOW" | "DENY" | "HUMAN_REVIEW",
 *   policyReason: string,
 *   finalAction: "CREATE_PAYMENT_LINK" | "RETRY" | "NO_ACTION" | "STOP" | "HUMAN_REVIEW"
 * }}
 */
function evaluateRecovery({ context, recoveryHistory, recommendation }) {
  const { maxAttempts, maxAmountPaise } = getPolicyLimits();

  const paymentStatus = context?.payment?.status;
  const attemptsForOrder = recoveryHistory?.attemptsForOrder ?? 0;
  const hasEmail = Boolean(context?.customer?.hasEmail);
  const hasContact = Boolean(context?.customer?.hasContact);
  const action = recommendation?.action;
  const requiresHumanReview = Boolean(recommendation?.requiresHumanReview);
  const amount = context?.payment?.amount ?? 0;

  // 1. Payment status is already captured or recovered
  if (paymentStatus === "captured" || paymentStatus === "recovered") {
    return {
      policyDecision: "DENY",
      policyReason: "Payment already captured or recovered",
      finalAction: "STOP",
    };
  }

  // 2. Maximum attempts on this order reached
  if (attemptsForOrder >= maxAttempts) {
    return {
      policyDecision: "DENY",
      policyReason: "Maximum recovery attempts exceeded for order",
      finalAction: "STOP",
    };
  }

  // 3. Payment link action without contact details
  if (action === "CREATE_PAYMENT_LINK" && !hasEmail && !hasContact) {
    return {
      policyDecision: "DENY",
      policyReason: "Cannot send payment link: customer has neither email nor contact",
      finalAction: "NO_ACTION",
    };
  }

  // 4. Recommendation explicitly requested human review
  if (requiresHumanReview) {
    return {
      policyDecision: "HUMAN_REVIEW",
      policyReason: "Recommendation flagged for human review",
      finalAction: "HUMAN_REVIEW",
    };
  }

  // 5. Payment amount exceeds risk threshold
  if (amount > maxAmountPaise) {
    return {
      policyDecision: "HUMAN_REVIEW",
      policyReason: "Payment amount exceeds automated recovery threshold",
      finalAction: "HUMAN_REVIEW",
    };
  }

  // 6. Action is not one of the five recognized valid actions
  if (!VALID_ACTIONS.includes(action)) {
    return {
      policyDecision: "DENY",
      policyReason: "Invalid recommendation action",
      finalAction: "NO_ACTION",
    };
  }

  // 7. All checks passed
  return {
    policyDecision: "ALLOW",
    policyReason: "Policy checks passed",
    finalAction: action,
  };
}

module.exports = {
  VALID_ACTIONS,
  evaluateRecovery,
};

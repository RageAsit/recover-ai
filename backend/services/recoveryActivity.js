const RecoveryAttempt = require("../models/RecoveryAttempt");

/**
 * Retrieves recent recovery activity audit records.
 *
 * NOTE ON PAYMENT IDENTIFIERS VS PII:
 * A Razorpay payment id is an internal identifier, not customer data, and an
 * audit view is useless without it. While recoveryQueue.js masks identifiers for
 * untrusted views, RecoveryAttempt stores no customer fields at all (no email,
 * no phone, no names), so no PII can leak from this collection by construction.
 * Full payment and order IDs are deliberately returned for full auditability.
 *
 * @param {Object} [options={}]
 * @param {number} [options.limit=50] - Number of attempts to fetch (clamped to max 200).
 * @returns {Promise<Array<Object>>} Allowlisted recovery attempt activity objects.
 */
async function getRecoveryActivity({ limit = 50 } = {}) {
  const parsedLimit = Number(limit);
  let clampedLimit = 50;

  if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
    clampedLimit = Math.min(parsedLimit, 200);
  }

  const attempts = await RecoveryAttempt.find({})
    .sort({ createdAt: -1 })
    .limit(clampedLimit)
    .lean();

  // Return an array built with an explicit .map() allowlist - no spread, no whole-document passthrough
  return attempts.map((doc) => ({
    id: String(doc._id),
    razorpayPaymentId: doc.razorpayPaymentId,
    razorpayOrderId: doc.razorpayOrderId ?? null,
    amount: doc.amount ?? null,
    action: doc.action ?? null,
    status: doc.status ?? null,
    policyDecision: doc.policyDecision ?? null,
    policyReason: doc.policyReason ?? null,
    llmReason: doc.llmReason ?? null,
    llmConfidence: doc.llmConfidence ?? null,
    modelVersion: doc.modelVersion ?? null,
    responseId: doc.responseId ?? null,
    externalReference: doc.externalReference ?? null,
    executionError: doc.executionError ?? null,
    createdAt: doc.createdAt,
  }));
}

module.exports = {
  getRecoveryActivity,
};

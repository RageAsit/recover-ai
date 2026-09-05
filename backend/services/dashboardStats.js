const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

/**
 * Computes the dashboard metrics from Payment and RecoveryAttempt collections.
 *
 * All amounts in paise. Returns an explicit allowlisted object — no raw
 * Mongoose documents, no PII, no Razorpay payloads.
 */
async function getDashboardStats() {
  // --- Payment aggregation ---
  const paymentStats = await Payment.aggregate([
    {
      $group: {
        _id: "$status",
        total: { $sum: "$amount" },
        count: { $sum: 1 },
      },
    },
  ]);

  let revenueAtRisk = 0;
  let revenueRecovered = 0;
  let failedPaymentCount = 0;
  let recoveredPaymentCount = 0;
  let capturedPaymentCount = 0;
  let totalPaymentCount = 0;

  for (const stat of paymentStats) {
    totalPaymentCount += stat.count;
    if (stat._id === "failed") {
      revenueAtRisk = stat.total;
      failedPaymentCount = stat.count;
    } else if (stat._id === "recovered") {
      revenueRecovered = stat.total;
      recoveredPaymentCount = stat.count;
    } else if (stat._id === "captured") {
      capturedPaymentCount = stat.count;
    }
  }

  const denominator = revenueRecovered + revenueAtRisk;
  let recoveryRate = 0;

  if (denominator > 0) {
    // The denominator is (recovered + failed), NOT just revenueAtRisk.
    // A recovered payment is no longer at risk (its status changed from failed to recovered),
    // so dividing by the outstanding figure alone (revenueAtRisk) would exclude it from the base
    // and could result in a percentage exceeding 100%.
    const rate = (revenueRecovered / denominator) * 100;
    recoveryRate = Math.round(rate * 10) / 10;
  }

  // --- RecoveryAttempt aggregation ---
  const attemptStats = await RecoveryAttempt.aggregate([
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]);

  let totalRecoveryAttemptCount = 0;
  let successfulRecoveryAttemptCount = 0;
  let pendingReviewCount = 0;
  let executedAttemptCount = 0;
  let allowedAttemptCount = 0;
  let deniedAttemptCount = 0;
  let failedAttemptCount = 0;

  for (const stat of attemptStats) {
    totalRecoveryAttemptCount += stat.count;
    if (stat._id === "succeeded") {
      successfulRecoveryAttemptCount = stat.count;
    } else if (stat._id === "human_review") {
      pendingReviewCount = stat.count;
    } else if (stat._id === "executed") {
      executedAttemptCount = stat.count;
    } else if (stat._id === "allowed") {
      allowedAttemptCount = stat.count;
    } else if (stat._id === "denied") {
      deniedAttemptCount = stat.count;
    } else if (stat._id === "failed") {
      failedAttemptCount = stat.count;
    }
  }

  return {
    revenueAtRisk,
    revenueRecovered,
    recoveryRate,
    failedPaymentCount,
    recoveredPaymentCount,
    capturedPaymentCount,
    totalPaymentCount,
    totalRecoveryAttemptCount,
    successfulRecoveryAttemptCount,
    pendingReviewCount,
    executedAttemptCount,
    allowedAttemptCount,
    deniedAttemptCount,
    failedAttemptCount,
  };
}

module.exports = { getDashboardStats };

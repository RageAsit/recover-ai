const Payment = require("../models/Payment");

/**
 * Returns the most recent failed payments for the recovery queue display.
 * Only "failed" — a recovered payment is no longer at risk.
 * Capped at 20 rows as a display limit.
 */
async function getRecoveryQueue() {
  const docs = await Payment.find({ status: "failed" })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  return docs.map((doc) => ({
    id: doc.razorpayPaymentId,
    customer: "#" + doc.razorpayPaymentId.slice(-6),
    amount: doc.amount,
    reason:
      doc.failureReason == null
        ? "Unknown"
        : doc.failureReason.length > 60
          ? doc.failureReason.slice(0, 60) + "\u2026"
          : doc.failureReason,
    action: "REVIEW",
  }));
}

module.exports = { getRecoveryQueue };

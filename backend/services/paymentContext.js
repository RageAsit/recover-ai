const Payment = require("../models/Payment");

/**
 * Assembles non-identifying context for a payment to enable LLM recovery reasoning.
 *
 * CRITICAL PRIVACY REQUIREMENT:
 * This object must NOT contain PII (raw email addresses, phone numbers, customer names).
 * Only boolean flags (hasEmail, hasContact) and aggregated historical counts are included.
 * Real contact details are retrieved separately by backend services only when dispatching actions.
 *
 * @param {string} razorpayPaymentId
 * @returns {Promise<{
 *   payment: {
 *     razorpayPaymentId: string,
 *     razorpayOrderId: string|null,
 *     amount: number,
 *     currency: string|null,
 *     status: string|null,
 *     method: string|null,
 *     failureReason: string|null,
 *     createdAt: Date
 *   },
 *   customer: {
 *     identifierType: "contact"|"email"|null,
 *     hasEmail: boolean,
 *     hasContact: boolean,
 *     priorFailed: number,
 *     priorSuccessful: number,
 *     totalSuccessfulAmount: number
 *   },
 *   order: {
 *     attemptsOnThisOrder: number
 *   }
 * } | null>}
 */
async function buildPaymentContext(razorpayPaymentId) {
  const payment = await Payment.findOne({ razorpayPaymentId }).lean();
  if (!payment) {
    return null;
  }

  // 1. Order attempts
  let attemptsOnThisOrder = 1;
  if (payment.razorpayOrderId) {
    attemptsOnThisOrder = await Payment.countDocuments({
      razorpayOrderId: payment.razorpayOrderId,
    });
  }

  // 2. Customer identification & history
  const hasContact = Boolean(payment.customerContact);
  const hasEmail = Boolean(payment.customerEmail);

  let identifierType = null;
  let customerFilter = null;

  if (hasContact) {
    identifierType = "contact";
    customerFilter = { customerContact: payment.customerContact };
  } else if (hasEmail) {
    identifierType = "email";
    customerFilter = { customerEmail: payment.customerEmail };
  }

  let priorFailed = 0;
  let priorSuccessful = 0;
  let totalSuccessfulAmount = 0;

  if (customerFilter) {
    // Exclude the current payment document from its own history counts
    const priorStats = await Payment.aggregate([
      {
        $match: {
          ...customerFilter,
          razorpayPaymentId: { $ne: payment.razorpayPaymentId },
        },
      },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalAmount: { $sum: "$amount" },
        },
      },
    ]);

    for (const group of priorStats) {
      if (group._id === "failed") {
        priorFailed += group.count;
      } else if (group._id === "captured" || group._id === "recovered") {
        priorSuccessful += group.count;
        totalSuccessfulAmount += group.totalAmount;
      }
    }
  } else {
    // When both customerContact and customerEmail are null, this is an UNKNOWN customer,
    // not a customer with verified zero history. All prior counts default to 0.
  }

  return {
    payment: {
      razorpayPaymentId: payment.razorpayPaymentId,
      razorpayOrderId: payment.razorpayOrderId ?? null,
      amount: payment.amount,
      currency: payment.currency ?? null,
      status: payment.status ?? null,
      method: payment.method ?? null,
      failureReason: payment.failureReason ?? null,
      createdAt: payment.createdAt,
    },
    customer: {
      identifierType,
      hasEmail,
      hasContact,
      priorFailed,
      priorSuccessful,
      totalSuccessfulAmount,
    },
    order: {
      attemptsOnThisOrder,
    },
  };
}

module.exports = { buildPaymentContext };

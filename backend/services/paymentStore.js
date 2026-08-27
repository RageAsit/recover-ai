const Payment = require("../models/Payment");

/**
 * Upsert a payment document from a normalized webhook event.
 *
 * Uses razorpayPaymentId as the dedup key so duplicate deliveries update the
 * existing row instead of duplicating it.
 *
 * When a capture arrives, any prior failed attempts for the same razorpayOrderId
 * are marked as "recovered". The incoming capture stays "captured" and is
 * excluded from metrics, so nothing is double counted.
 *
 * @param {Object} normalized - Output of normalizePaymentEvent().
 * @returns {Promise<Document>} The upserted Mongoose document.
 */
async function savePaymentFromEvent(normalized) {
  const filter = { razorpayPaymentId: normalized.paymentId };

  // Null values from the normalized event become undefined so mongoose strips
  // them from the update. This prevents a capture from wiping failureReason
  // that was set by the prior failure.
  const update = {
    razorpayPaymentId: normalized.paymentId,
    razorpayOrderId: normalized.orderId ?? undefined,
    amount: normalized.amount,
    currency: normalized.currency ?? undefined,
    status: normalized.status,
    method: normalized.method ?? undefined,
    failureReason: normalized.failureReason ?? undefined,
  };
  const opts = { upsert: true, new: true, runValidators: true };

  let savedDoc;
  try {
    savedDoc = await Payment.findOneAndUpdate(filter, update, opts);
  } catch (err) {
    // Duplicate-key race: two concurrent upserts both found no document and
    // both tried to insert. The loser gets E11000. Retry once — the document
    // now exists so the second attempt updates instead of inserting.
    if (err.code === 11000) {
      savedDoc = await Payment.findOneAndUpdate(filter, update, opts);
    } else {
      throw err;
    }
  }

  if (normalized.status === "captured" && normalized.orderId) {
    const res = await Payment.updateMany(
      {
        razorpayOrderId: normalized.orderId,
        status: "failed",
        razorpayPaymentId: { $ne: normalized.paymentId },
      },
      { $set: { status: "recovered" } }
    );

    if (res.modifiedCount > 0) {
      console.log(
        `[recovery] Marked ${res.modifiedCount} failed payment(s) as recovered for orderId=${normalized.orderId}`
      );
    }
  }

  return savedDoc;
}

module.exports = { savePaymentFromEvent };


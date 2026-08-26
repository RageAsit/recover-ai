const Payment = require("../models/Payment");

/**
 * Upsert a payment document from a normalized webhook event.
 *
 * Uses razorpayPaymentId as the dedup key so a later payment.captured for the
 * same id updates the existing row instead of duplicating it.
 *
 * When a capture arrives for a payment that previously failed, the status is
 * stored as "recovered" rather than "captured" so revenue-recovered metrics
 * only count money that was genuinely at risk.
 *
 * @param {Object} normalized - Output of normalizePaymentEvent().
 * @returns {Promise<Document>} The upserted Mongoose document.
 */
async function savePaymentFromEvent(normalized) {
  const filter = { razorpayPaymentId: normalized.paymentId };

  // Determine the correct status to store. A capture that follows a prior
  // failure is a recovery; an ordinary first-try capture stays "captured".
  //
  // NOTE: This read-then-write leaves a small race window where a concurrent
  // payment.failed could land between the findOne and the upsert. That can
  // only ever undercount recoveries (the capture would be stored as "captured"
  // instead of "recovered"), never inflate them, and the two events are
  // normally minutes or hours apart, so the risk is acceptable.
  let status = normalized.status;
  if (normalized.status === "captured") {
    const existing = await Payment.findOne(filter).select("status").lean();
    if (existing?.status === "failed") {
      status = "recovered";
    }
  }

  // Null values from the normalized event become undefined so mongoose strips
  // them from the update. This prevents a capture from wiping failureReason
  // that was set by the prior failure.
  const update = {
    razorpayPaymentId: normalized.paymentId,
    razorpayOrderId: normalized.orderId ?? undefined,
    amount: normalized.amount,
    currency: normalized.currency ?? undefined,
    status,
    method: normalized.method ?? undefined,
    failureReason: normalized.failureReason ?? undefined,
  };
  const opts = { upsert: true, new: true, runValidators: true };

  try {
    return await Payment.findOneAndUpdate(filter, update, opts);
  } catch (err) {
    // Duplicate-key race: two concurrent upserts both found no document and
    // both tried to insert. The loser gets E11000. Retry once — the document
    // now exists so the second attempt updates instead of inserting.
    if (err.code === 11000) {
      return Payment.findOneAndUpdate(filter, update, opts);
    }
    throw err;
  }
}

module.exports = { savePaymentFromEvent };


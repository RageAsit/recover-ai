const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

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
    customerEmail: normalized.customerEmail ?? undefined,
    customerContact: normalized.customerContact ?? undefined,
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

/**
 * Process a verified payment_link.paid webhook event.
 *
 * Links back to the RecoveryAttempt via payment_link.reference_id, verifies that
 * the payment link id matches attempt.externalReference, ensures the original
 * Payment is currently "failed" and transitions it to "recovered", and only then
 * updates RecoveryAttempt to "succeeded".
 *
 * @param {Object} normalized - Output of normalizePaymentEvent().
 * @returns {Promise<{ handled: boolean, reason?: string, alreadyProcessed?: boolean }>}
 */
async function processPaymentLinkPaid(normalized) {
  const referenceId = normalized.paymentLinkReferenceId;
  const paymentLinkId = normalized.paymentLinkId;

  // 4. If the reference id is missing, invalid, or does not match an existing attempt,
  // acknowledge the webhook safely without crashing.
  if (!referenceId) {
    console.warn(
      "[webhook] payment_link.paid: missing reference_id; acknowledging without update"
    );
    return { handled: false, reason: "missing_reference_id" };
  }

  if (!mongoose.Types.ObjectId.isValid(referenceId)) {
    console.warn(
      `[webhook] payment_link.paid: invalid reference_id "${referenceId}"; acknowledging without update`
    );
    return { handled: false, reason: "invalid_reference_id" };
  }

  const attempt = await RecoveryAttempt.findById(referenceId);
  if (!attempt) {
    console.warn(
      `[webhook] payment_link.paid: attempt not found for referenceId=${referenceId}; acknowledging without update`
    );
    return { handled: false, reason: "attempt_not_found" };
  }

  // 6. If attempt.externalReference exists and does not match the webhook payment link id,
  // do not update money/recovery state; log a safe warning and acknowledge.
  if (attempt.externalReference && attempt.externalReference !== paymentLinkId) {
    console.warn(
      `[webhook] payment_link.paid mismatch: linkId=${paymentLinkId} does not match externalReference=${attempt.externalReference} for attempt=${attempt._id}; ignoring`
    );
    return { handled: false, reason: "link_id_mismatch" };
  }

  if (!attempt.externalReference) {
    console.warn(
      `[webhook] payment_link.paid: attempt ${attempt._id} has no externalReference set; ignoring`
    );
    return { handled: false, reason: "missing_external_reference" };
  }

  // Preserve duplicate-webhook idempotency: an already succeeded/recovered pair
  // must remain a successful safe acknowledgement.
  if (attempt.status === "succeeded") {
    const existingPayment = await Payment.findOne({
      razorpayPaymentId: attempt.razorpayPaymentId,
    }).lean();

    if (existingPayment && existingPayment.status === "recovered") {
      console.log(
        `[webhook] payment_link.paid duplicate delivery: attempt=${attempt._id} already succeeded, payment=${attempt.razorpayPaymentId} already recovered`
      );
      return { handled: true, alreadyProcessed: true };
    }
  }

  // Transition original Payment from "failed" to "recovered".
  // Only a payment currently in "failed" state can be recovered.
  const paymentResult = await Payment.updateOne(
    { razorpayPaymentId: attempt.razorpayPaymentId, status: "failed" },
    { $set: { status: "recovered" } }
  );

  // If the payment was not updated, investigate why to return a safe reason and log
  if (paymentResult.modifiedCount !== 1) {
    const payment = await Payment.findOne({
      razorpayPaymentId: attempt.razorpayPaymentId,
    }).lean();

    if (!payment) {
      console.warn(
        `[webhook] payment_link.paid aborted: original payment not found for paymentId=${attempt.razorpayPaymentId}, attempt=${attempt._id}`
      );
      return { handled: false, reason: "payment_not_found" };
    }

    // When the linked Payment is already "recovered" and the attempt is still "executed",
    // treat a verified matching payment_link.paid webhook as a safe recovery-finalization retry:
    if (payment.status === "recovered" && attempt.status === "executed") {
      await RecoveryAttempt.updateOne(
        { _id: attempt._id },
        { $set: { status: "succeeded" } }
      );

      console.log(
        `[webhook] payment_link.paid retry reconciled: payment=${attempt.razorpayPaymentId} already recovered, attempt=${attempt._id} marked succeeded`
      );
      return { handled: true, reconciled: true, alreadyProcessed: true };
    }

    console.warn(
      `[webhook] payment_link.paid aborted: original payment ${payment.razorpayPaymentId} is not in 'failed' status (current status: ${payment.status}), attempt=${attempt._id}`
    );
    return { handled: false, reason: "payment_not_failed" };
  }

  // Payment was successfully transitioned from "failed" to "recovered" -
  // now mark RecoveryAttempt as "succeeded".
  await RecoveryAttempt.updateOne(
    { _id: attempt._id },
    { $set: { status: "succeeded" } }
  );

  console.log(
    `[webhook] payment_link.paid processed: payment=${attempt.razorpayPaymentId} marked recovered, attempt=${attempt._id} marked succeeded`
  );

  return { handled: true };
}

module.exports = { savePaymentFromEvent, processPaymentLinkPaid };


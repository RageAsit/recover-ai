/**
 * THIS FILE IS THE PII BOUNDARY.
 * paymentContext.js deliberately keeps contact details out of the LLM path;
 * this service is the one place that reads them back out of the Payment document
 * in order to dispatch.
 */

const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { createPaymentLink } = require("./razorpayService");

/**
 * Executes a payment link creation for a recovery attempt.
 *
 * @param {Object} params
 * @param {Object} params.attempt - RecoveryAttempt document or object
 * @returns {Promise<Object|null>} Sanitized link object on success, or null on failure.
 */
async function executePaymentLinkForAttempt({ attempt }) {
  if (!attempt || !attempt.razorpayPaymentId) {
    return null;
  }

  // ALREADY-EXECUTED GUARD, at the very top before anything else:
  // If attempt.status is "executed" OR attempt.externalReference is already set,
  // return null immediately. Do NOT call Razorpay and do NOT modify the attempt.
  //
  // Why this is critical: without it, a second call sends the same referenceId,
  // Razorpay rejects it as a duplicate, the catch block runs, and status is downgraded
  // from "executed" to "failed" while externalReference still points at a LIVE PAYABLE
  // LINK. The system would then believe dispatch failed for a link the customer can
  // still pay. Razorpay's uniqueness check is the backstop, not the primary guard - we
  // must be idempotent at our own layer first.
  if (attempt.status === "executed" || Boolean(attempt.externalReference)) {
    return null;
  }

  const referenceId = String(attempt._id);

  // Re-read the Payment document by attempt.razorpayPaymentId.
  // Do NOT trust the context object - time has passed since the decision was made,
  // so the live document is the source of truth for where to send.
  const payment = await Payment.findOne({
    razorpayPaymentId: attempt.razorpayPaymentId,
  }).lean();

  // DO NOT DISPATCH AGAINST A PAYMENT THAT IS NO LONGER AT RISK.
  // The decision was made at some earlier moment. If a capture has landed since
  // then, sending a recovery link asks a customer to pay an invoice they have
  // already settled. Webhook delivery is not ordered, so this is reachable in
  // normal operation, not just in theory. Only a payment still in a failed state
  // may be dispatched against.
  if (!payment) {
    const errorMsg = "Payment record not found at dispatch time";
    await RecoveryAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: "failed", executionError: errorMsg } }
    );
    attempt.status = "failed";
    attempt.executionError = errorMsg;
    console.log(
      `[recoveryExecutor] aborted attempt ${attempt._id} - payment not found`
    );
    return null;
  }

  if (payment.status !== "failed") {
    const errorMsg = `Payment no longer at risk at dispatch time (status: ${payment.status})`;
    await RecoveryAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: "failed", executionError: errorMsg } }
    );
    attempt.status = "failed";
    attempt.executionError = errorMsg;
    console.log(
      `[recoveryExecutor] aborted attempt ${attempt._id} - payment status is ${payment.status}`
    );
    return null;
  }

  // Derive customerContact / customerEmail from that document.
  const customerContact = payment?.customerContact?.trim() || undefined;
  const customerEmail = payment?.customerEmail?.trim() || undefined;

  // If BOTH are absent, do NOT call Razorpay. Set the attempt status to "failed",
  // set policyReason untouched, and return. This is a second check at the money
  // boundary, complementing policy rule 3 which ran against possibly-stale data.
  // Set executionError to explain why dispatch failed.
  if (!customerContact && !customerEmail) {
    const errorMsg = "No contact details available at dispatch time";
    await RecoveryAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: "failed", executionError: errorMsg } }
    );
    attempt.status = "failed";
    attempt.executionError = errorMsg;

    console.log(
      `[recoveryExecutor] aborted attempt ${attempt._id}, referenceId: ${referenceId} - no contact details`
    );
    return null;
  }

  // Otherwise call razorpayService.createPaymentLink with:
  // amount: attempt.amount (paise, no conversion)
  // referenceId: String(attempt._id) (unique by construction and enforced by Razorpay)
  // description: a short static string, NO customer data in it
  try {
    const link = await createPaymentLink({
      amount: attempt.amount,
      referenceId,
      description: "Payment recovery link",
      customerContact,
      customerEmail,
    });

    // On success: update the attempt to status "executed" and set externalReference to the returned link id
    await RecoveryAttempt.updateOne(
      { _id: attempt._id },
      { $set: { status: "executed", externalReference: link.id } }
    );
    attempt.status = "executed";
    attempt.externalReference = link.id;

    // LOGGING: log the attempt id, link id and referenceId only. Never log the short URL, customerContact or customerEmail.
    console.log(
      `[recoveryExecutor] executed attempt ${attempt._id}, linkId: ${link.id}, referenceId: ${referenceId}`
    );

    return link;
  } catch (err) {
    // On failure: update the attempt to status "failed".
    // STOP WRITING TO policyReason. Write the sanitized message to executionError instead.
    // policyReason belongs to the policy engine and this service must never touch it.
    // Never store or log a raw SDK error.
    const isSanitized = Boolean(err && err.isSanitized);
    const safeReason = isSanitized ? err.message : undefined;

    const updateFields = { status: "failed" };
    if (safeReason) {
      updateFields.executionError = safeReason;
      attempt.executionError = safeReason;
    }

    await RecoveryAttempt.updateOne(
      { _id: attempt._id },
      { $set: updateFields }
    );
    attempt.status = "failed";

    // LOGGING: never log raw SDK error, never log short URL, customerContact or customerEmail
    console.error(
      `[recoveryExecutor] failed attempt ${attempt._id}, referenceId: ${referenceId}${
        isSanitized ? ` - reason: ${safeReason}` : ""
      }`
    );

    return null;
  }
}

module.exports = {
  executePaymentLinkForAttempt,
};

const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { processPaymentLinkPaid } = require("../services/paymentStore");

// Dedicated synthetic demo payment constants
const DEMO_PAYMENT_ID = "pay_DEMO_RECOVERAI_001";
const DEMO_ORDER_ID = "order_DEMO_RECOVERAI_001";

/**
 * Validates whether a payment record is a server-registered demo payment.
 * Prevents reset or mutation of arbitrary or production payments.
 */
function isDemoPayment(payment) {
  if (!payment) return false;
  return (
    payment.isDemo === true ||
    payment.razorpayPaymentId === DEMO_PAYMENT_ID ||
    (typeof payment.razorpayPaymentId === "string" &&
      (payment.razorpayPaymentId.startsWith("pay_DEMO_") ||
        payment.razorpayPaymentId.startsWith("pay_SYNTHETIC_DEMO_")))
  );
}

/**
 * Returns demo mode configuration and active mock statuses.
 *
 * GET /api/demo/status
 */
async function getDemoStatus(req, res) {
  const isEnabled = process.env.DEMO_MODE === "true";
  return res.status(200).json({
    success: true,
    enabled: isEnabled,
    razorpayMock: isEnabled && process.env.RAZORPAY_MOCK === "true",
    llmMock: process.env.LLM_MOCK === "true",
    demoPaymentId: DEMO_PAYMENT_ID,
  });
}

/**
 * Ensures the dedicated synthetic failed demo payment exists in the database.
 * If already existing, returns it without modifying or resetting data.
 *
 * POST /api/demo/payments/ensure
 * GET  /api/demo/payments/ensure
 */
async function ensureDemoPayment(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[demo] MongoDB not connected - cannot ensure demo payment");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    let payment = await Payment.findOne({ razorpayPaymentId: DEMO_PAYMENT_ID });
    if (!payment) {
      payment = await Payment.create({
        razorpayPaymentId: DEMO_PAYMENT_ID,
        razorpayOrderId: DEMO_ORDER_ID,
        amount: 249900,
        currency: "INR",
        status: "failed",
        method: "upi",
        failureReason: "Payment declined by customer bank due to technical timeout",
        isDemo: true,
      });
      console.log(`[demo] Seeded synthetic demo payment: ${DEMO_PAYMENT_ID}`);
    }

    return res.status(200).json({
      success: true,
      demo: true,
      payment: {
        id: payment.razorpayPaymentId,
        orderId: payment.razorpayOrderId ?? null,
        amount: payment.amount,
        currency: payment.currency ?? "INR",
        status: payment.status,
        method: payment.method ?? "upi",
        failureReason: payment.failureReason ?? null,
        isDemo: true,
      },
    });
  } catch (err) {
    console.error(`[demo] Error ensuring demo payment: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to ensure demo payment",
    });
  }
}

/**
 * Simulates the customer paying an already-created recovery link.
 *
 * POST /api/demo/recovery-attempts/:attemptId/payment
 *
 * CRITICAL SAFETY & INTEGRITY:
 * - Guarded strictly by DEMO_MODE=true via route middleware.
 * - Reuses existing processPaymentLinkPaid reconciliation in paymentStore.js.
 * - Enforces ObjectId validation and externalReference presence.
 * - Returns only sanitized allowlisted fields; zero PII or raw provider payloads.
 * - Idempotent on duplicate deliveries.
 */
async function simulateCustomerPayment(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[demo] MongoDB not connected - cannot simulate payment");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  const { attemptId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(attemptId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid attempt id",
    });
  }

  try {
    const attempt = await RecoveryAttempt.findById(attemptId);
    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: "Recovery attempt not found",
      });
    }

    if (!attempt.externalReference) {
      return res.status(409).json({
        success: false,
        message: "Attempt does not have a payment link created yet",
        status: attempt.status,
      });
    }

    // Build the minimal normalized event expected by processPaymentLinkPaid
    const normalized = {
      event: "payment_link.paid",
      paymentLinkId: attempt.externalReference,
      paymentLinkReferenceId: String(attempt._id),
      paidAmount: attempt.amount,
    };

    // Delegate directly to the existing production reconciliation logic
    const result = await processPaymentLinkPaid(normalized);

    if (!result.handled) {
      return res.status(409).json({
        success: false,
        message: `Simulation not handled: ${result.reason || "unknown"}`,
        reason: result.reason,
      });
    }

    // Re-fetch updated records to confirm persisted state
    const updatedAttempt = await RecoveryAttempt.findById(attemptId).lean();
    const updatedPayment = await Payment.findOne({
      razorpayPaymentId: attempt.razorpayPaymentId,
    }).lean();

    if (!updatedPayment || !updatedAttempt) {
      return res.status(500).json({
        success: false,
        message: "Failed to load updated records after payment simulation",
      });
    }

    console.log(
      `[demo] Simulated customer payment: attemptId=${attemptId}, linkId=${attempt.externalReference}, paymentStatus=${updatedPayment.status}, attemptStatus=${updatedAttempt.status}`
    );

    // Sanitized allowlisted response only
    return res.status(200).json({
      success: true,
      demo: true,
      attemptId: String(updatedAttempt._id),
      paymentId: updatedPayment.razorpayPaymentId,
      attemptStatus: updatedAttempt.status,
      paymentStatus: updatedPayment.status,
      amount: updatedPayment.amount,
      alreadyProcessed: Boolean(result.alreadyProcessed),
    });
  } catch (err) {
    console.error(`[demo] Error simulating payment: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to simulate payment",
    });
  }
}

/**
 * Safely resets a demo payment record back to 'failed' status and resets its demo attempts,
 * allowing judges to re-run the walkthrough without corrupting unrelated data.
 *
 * STRICT SAFETY RULES:
 * - Only operates on registered demo payments (isDemo === true or matching DEMO_PAYMENT_ID / pay_DEMO_*).
 * - Non-demo payments are rejected with 403 Forbidden without mutating anything.
 * - Only deletes recovery attempts belonging to this specific demo payment.
 * - Strictly idempotent.
 *
 * POST /api/demo/payments/:razorpayPaymentId/reset
 */
async function resetDemoPayment(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[demo] MongoDB not connected - cannot reset demo payment");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  const { razorpayPaymentId } = req.params;
  if (!razorpayPaymentId || typeof razorpayPaymentId !== "string") {
    return res.status(400).json({
      success: false,
      message: "Invalid payment id",
    });
  }

  try {
    const payment = await Payment.findOne({ razorpayPaymentId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    // STRICT SAFETY GUARD: Do not allow reset of arbitrary or real payments.
    // Must be an explicitly registered demo payment record.
    if (!isDemoPayment(payment)) {
      console.warn(
        `[demo] Refused reset for non-demo payment: paymentId=${razorpayPaymentId}`
      );
      return res.status(403).json({
        success: false,
        message: "Reset is only permitted for registered demo payments",
      });
    }

    // Revert demo payment status to failed
    await Payment.updateOne(
      { razorpayPaymentId },
      { $set: { status: "failed" } }
    );

    // Delete ONLY attempts belonging to this specific demo payment.
    // Unrelated payments and their recovery attempts are completely untouched.
    const deleteResult = await RecoveryAttempt.deleteMany({
      razorpayPaymentId,
    });

    console.log(
      `[demo] Safely reset demo payment: paymentId=${razorpayPaymentId}, removedAttempts=${deleteResult.deletedCount}`
    );

    return res.status(200).json({
      success: true,
      demo: true,
      paymentId: razorpayPaymentId,
      status: "failed",
      payment: {
        id: razorpayPaymentId,
        status: "failed",
      },
      resetAttemptsCount: deleteResult.deletedCount,
    });
  } catch (err) {
    console.error(`[demo] Error resetting demo payment: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to reset demo payment",
    });
  }
}

module.exports = {
  getDemoStatus,
  ensureDemoPayment,
  simulateCustomerPayment,
  resetDemoPayment,
  DEMO_PAYMENT_ID,
  DEMO_ORDER_ID,
};

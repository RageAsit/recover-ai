const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { getRecoveryQueue } = require("../services/recoveryQueue");
const { runRecoveryAgent } = require("../services/recoveryAgent");
const { getRecoveryActivity } = require("../services/recoveryActivity");
const { executePaymentLinkForAttempt } = require("../services/recoveryExecutor");

// An approval is not valid forever. A decision made hours ago was made
// against a payment state that may no longer hold, and the operator who
// approved it is no longer watching. Stale approvals must be re-decided,
// not silently dispatched.
const MAX_APPROVAL_AGE_MS = 60 * 60 * 1000; // 60 minutes

async function getRecovery(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot fetch queue");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    const queue = await getRecoveryQueue();
    return res.status(200).json(queue);
  } catch (err) {
    console.error(`[recovery] Failed to fetch queue: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch queue",
    });
  }
}

/**
 * Retrieves recent recovery activity audit records.
 *
 * GET /api/recovery/activity?limit=50
 */
async function getActivity(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot fetch activity");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    let limit;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (Number.isInteger(parsed) && parsed > 0) {
        limit = parsed;
      }
    }

    const attempts = await getRecoveryActivity(limit !== undefined ? { limit } : {});
    return res.status(200).json({
      success: true,
      count: attempts.length,
      attempts,
    });
  } catch (err) {
    console.error(`[recovery] Failed to fetch activity: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch activity",
    });
  }
}

/**
 * Triggers the recovery agent pipeline for a specific payment.
 *
 * POST /api/recovery/:razorpayPaymentId/run
 * Body: { execute?: boolean } (default false)
 */
async function runAgentForPayment(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot run recovery agent");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  const { razorpayPaymentId } = req.params;
  // execute must be STRICTLY === true to dispatch. Any other value
  // (undefined, "true", 1, null) means decision-only. Do not coerce.
  const execute = req.body?.execute === true;

  // Log one line per request: the payment id and whether execute was true.
  // Never log contact details, email, or the short URL.
  console.log(`[recovery] runAgentForPayment: paymentId=${razorpayPaymentId}, execute=${execute}`);

  try {
    const result = await runRecoveryAgent(razorpayPaymentId, { execute });
    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    // RESPONSE SHAPE IS AN EXPLICIT ALLOWLIST. Build the JSON field by field.
    // customerEmail and customerContact must appear NOWHERE in this response.
    const response = {
      success: true,
      paymentId: razorpayPaymentId,
      payment: {
        amount: result.context.payment.amount,
        currency: result.context.payment.currency,
        status: result.context.payment.status,
        method: result.context.payment.method,
      },
      customer: {
        hasEmail: Boolean(result.context.customer.hasEmail),
        hasContact: Boolean(result.context.customer.hasContact),
      },
      recommendation: {
        action: result.recommendation.action,
        confidence: result.recommendation.confidence,
        reason: result.recommendation.reason,
        requiresHumanReview: Boolean(result.recommendation.requiresHumanReview),
        modelVersion: result.recommendation.modelVersion,
        responseId: result.recommendation.responseId,
      },
      decision: {
        policyDecision: result.policyResult.policyDecision,
        policyReason: result.policyResult.policyReason,
        finalAction: result.policyResult.finalAction,
      },
      history: {
        attemptsForOrder: result.recoveryHistory.attemptsForOrder,
        attemptsForPayment: result.recoveryHistory.attemptsForPayment,
        agentRunsForOrder: result.recoveryHistory.agentRunsForOrder,
      },
      attempt: {
        id: String(result.attempt._id),
        status: result.attempt.status,
        externalReference: result.attempt.externalReference ?? null,
        executionError: result.attempt.executionError ?? null,
        createdAt: result.attempt.createdAt,
      },
      execution: result.execution
        ? {
            linkId: result.execution.id,
            shortUrl: result.execution.shortUrl,
            status: result.execution.status,
            amount: result.execution.amount,
          }
        : null,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error(`[recovery] runAgentForPayment failed for paymentId=${razorpayPaymentId}: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to run recovery agent",
    });
  }
}

// This endpoint dispatches an EXISTING RecoveryAttempt. It deliberately does
// NOT create a new attempt row, and never re-runs the LLM or the policy engine.
// Re-running the pipeline to dispatch would create a second attempt row, and
// since both "allowed" and "executed" count toward the budget, a human clicking
// "approve" would consume a recovery attempt for doing nothing but approving.
// Dispatch must act on the decision that was already recorded and approved.
async function executeAttempt(req, res) {
  // a. Database connectivity guard
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot execute attempt");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  // b. Valid ObjectId guard before any query
  const { attemptId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(attemptId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid attempt id",
    });
  }

  try {
    // c. Attempt lookup
    const attempt = await RecoveryAttempt.findById(attemptId);
    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: "Attempt not found",
      });
    }

    // d. Already executed guard
    if (attempt.status === "executed" || Boolean(attempt.externalReference)) {
      return res.status(200).json({
        success: true,
        alreadyExecuted: true,
        attemptId: String(attempt._id),
        status: attempt.status,
        externalReference: attempt.externalReference ?? null,
      });
    }

    // e. Approved decision & action guard
    if (attempt.policyDecision !== "ALLOW" || attempt.action !== "CREATE_PAYMENT_LINK") {
      return res.status(409).json({
        success: false,
        message: "Attempt is not approved for dispatch",
        policyDecision: attempt.policyDecision,
        action: attempt.action,
      });
    }

    // f. Freshness guard
    const ageMs = Date.now() - new Date(attempt.createdAt).getTime();
    if (ageMs > MAX_APPROVAL_AGE_MS) {
      const ageMinutes = Math.round(ageMs / (60 * 1000));
      return res.status(409).json({
        success: false,
        message: "Approval is stale; re-run the agent",
        ageMinutes,
      });
    }

    // Pass all guards -> dispatch attempt
    const link = await executePaymentLinkForAttempt({ attempt });

    // RE-READ the attempt from the database to build response from persisted document
    const persisted = await RecoveryAttempt.findById(attemptId).lean();
    if (!persisted) {
      return res.status(404).json({
        success: false,
        message: "Attempt not found after execution",
      });
    }

    if (!link) {
      // Failure (executor returned null) -> 200 with success: false
      console.log(`[recovery] executeAttempt: attemptId=${attemptId}, outcome=failed`);
      return res.status(200).json({
        success: false,
        attemptId: String(persisted._id),
        status: persisted.status,
        executionError: persisted.executionError ?? null,
      });
    }

    // Success -> 200 with explicit allowlist (no PII, no short URL logged)
    console.log(`[recovery] executeAttempt: attemptId=${attemptId}, outcome=executed`);
    return res.status(200).json({
      success: true,
      alreadyExecuted: false,
      attemptId: String(persisted._id),
      status: persisted.status,
      externalReference: persisted.externalReference ?? null,
      link: {
        linkId: link.id,
        shortUrl: link.shortUrl,
        status: link.status,
        amount: link.amount,
      },
    });
  } catch (err) {
    console.error(`[recovery] executeAttempt error for attemptId=${attemptId}: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to execute recovery attempt",
    });
  }
}

/**
 * GET /api/recovery/payments/:razorpayPaymentId
 *
 * Fetches the Payment and its RecoveryAttempt history (newest first).
 * Explicit allowlist only - strictly excludes customer contact details (PII),
 * short URLs, and raw provider payloads.
 */
async function getPaymentDetail(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot fetch payment detail");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  const { razorpayPaymentId } = req.params;
  if (!razorpayPaymentId || typeof razorpayPaymentId !== "string") {
    return res.status(400).json({
      success: false,
      message: "Payment ID required",
    });
  }

  try {
    const payment = await Payment.findOne({ razorpayPaymentId }).lean();
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    const attempts = await RecoveryAttempt.find({ razorpayPaymentId })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      payment: {
        id: payment.razorpayPaymentId,
        orderId: payment.razorpayOrderId ?? null,
        amount: payment.amount,
        currency: payment.currency ?? null,
        status: payment.status,
        method: payment.method ?? null,
        failureReason: payment.failureReason ?? null,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      },
      attempts: attempts.map((doc) => ({
        id: String(doc._id),
        action: doc.action ?? null,
        status: doc.status ?? null,
        amount: doc.amount ?? null,
        policyDecision: doc.policyDecision ?? null,
        policyReason: doc.policyReason ?? null,
        llmReason: doc.llmReason ?? null,
        llmConfidence: doc.llmConfidence ?? null,
        modelVersion: doc.modelVersion ?? null,
        executionError: doc.executionError ?? null,
        externalReference: doc.externalReference ?? null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      })),
    });
  } catch (err) {
    console.error(`[recovery] Failed to fetch payment detail: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment detail",
    });
  }
}

module.exports = {
  getRecovery,
  getActivity,
  getPaymentDetail,
  runAgentForPayment,
  executeAttempt,
};


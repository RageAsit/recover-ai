const mongoose = require("mongoose");

const recoveryAttemptSchema = new mongoose.Schema(
  {
    razorpayPaymentId: {
      type: String,
      required: true,
      index: true,
    },
    razorpayOrderId: {
      type: String,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "CREATE_PAYMENT_LINK",
        "RETRY",
        "NO_ACTION",
        "STOP",
        "HUMAN_REVIEW",
      ],
    },
    status: {
      type: String,
      enum: [
        "pending",
        "allowed",
        "denied",
        "human_review",
        "executed",
        "succeeded",
        "failed",
      ],
      default: "pending",
    },
    amount: Number,
    llmReason: String,
    llmConfidence: Number,
    policyDecision: {
      type: String,
      enum: ["ALLOW", "DENY", "HUMAN_REVIEW"],
    },
    policyReason: String,
    // llmReason is what the model recommended, policyReason is what the
    // deterministic engine decided, executionError is what went wrong at dispatch.
    // These three must never be collapsed into each other - the audit trail's
    // whole value is showing which layer produced which outcome.
    executionError: String,
    modelVersion: String,
    responseId: String,
    externalReference: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("RecoveryAttempt", recoveryAttemptSchema);

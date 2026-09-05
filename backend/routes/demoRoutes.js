const express = require("express");
const router = express.Router();
const {
  getDemoStatus,
  ensureDemoPayment,
  simulateCustomerPayment,
  resetDemoPayment,
} = require("../controllers/demoController");

/**
 * Middleware: Strictly requires DEMO_MODE === "true" to access any demo simulation endpoint.
 */
function requireDemoMode(req, res, next) {
  if (process.env.DEMO_MODE !== "true") {
    return res.status(404).json({
      success: false,
      message: "Demo mode is not enabled",
    });
  }
  next();
}

// GET /api/demo/status - reveals whether demo mode is currently enabled
router.get("/status", getDemoStatus);

// POST & GET /api/demo/payments/ensure - idempotently ensures synthetic demo payment exists
router.post("/payments/ensure", requireDemoMode, ensureDemoPayment);
router.get("/payments/ensure", requireDemoMode, ensureDemoPayment);

// POST /api/demo/recovery-attempts/:attemptId/payment - simulate customer paying recovery link
router.post(
  "/recovery-attempts/:attemptId/payment",
  requireDemoMode,
  simulateCustomerPayment
);

// POST /api/demo/payments/:razorpayPaymentId/reset - reset payment back to failed for repeat demo
router.post(
  "/payments/:razorpayPaymentId/reset",
  requireDemoMode,
  resetDemoPayment
);

module.exports = router;

const express = require("express");
const {
  getRecovery,
  getActivity,
  getPaymentDetail,
  runAgentForPayment,
  executeAttempt,
} = require("../controllers/recoveryController");

const router = express.Router();

router.get("/", getRecovery);
router.get("/activity", getActivity);
router.get("/payments/:razorpayPaymentId", getPaymentDetail);
router.post("/attempts/:attemptId/execute", executeAttempt);
router.post("/:razorpayPaymentId/run", runAgentForPayment);

module.exports = router;

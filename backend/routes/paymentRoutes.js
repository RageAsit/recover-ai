const express = require("express");

const paymentController = require("../controllers/paymentController");

const router = express.Router();

// Mounted at /api/payments
router.get("/", paymentController.getPayments);
router.post("/orders", paymentController.createPaymentOrder);

module.exports = router;

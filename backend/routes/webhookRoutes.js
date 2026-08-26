const express = require("express");

const webhookController = require("../controllers/webhookController");

const router = express.Router();

// Mounted at /api/webhooks
//
// express.raw() keeps the body as an untouched Buffer instead of parsing it.
// type: () => true captures the raw bytes for ANY request (even one with no
// Content-Type header) - signature verification must run against exactly what
// Razorpay sent. Real Razorpay webhooks send application/json, but we don't
// want capture to depend on the header being present.
router.post(
  "/razorpay",
  express.raw({ type: () => true }),
  webhookController.receiveRazorpayWebhook
);

module.exports = router;

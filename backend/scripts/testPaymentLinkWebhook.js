/**
 * Focused tests for Razorpay payment_link.paid webhook handling.
 *
 * Tests the recovery loop observation when a customer pays via a recovery link:
 * - Signature verification and security rejection (401)
 * - Safe acknowledgment when reference_id is missing, invalid, or nonexistent (200)
 * - Safe acknowledgment when link ID does not match attempt.externalReference (200, no state update)
 * - Successful state transitions:
 *     RecoveryAttempt.status: "executed" -> "succeeded"
 *     Payment.status: "failed" -> "recovered"
 * - Idempotency on duplicate deliveries
 * - Clean teardown of synthetic test records
 *
 * Usage:
 *   node scripts/testPaymentLinkWebhook.js
 */

require("dotenv").config();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "whsec_local_dev_only";
const URL = `${BASE_URL}/api/webhooks/razorpay`;

const SYNTHETIC_PREFIX = "pay_SYNTHETIC_PLINK_";
const FAILED_PAYMENT_ID = `${SYNTHETIC_PREFIX}001`;
const ORDER_ID = "order_SYNTHETIC_PLINK_001";
const LINK_ID = "plink_SYNTHETIC_TEST_001";
const MISMATCHED_LINK_ID = "plink_SYNTHETIC_MISMATCH_999";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${shown}`);
}

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

async function postWebhook(payloadObj, { signature = undefined, signed = true } = {}) {
  const rawBody = JSON.stringify(payloadObj);
  const headers = { "Content-Type": "application/json" };
  const sig = signature !== undefined ? signature : signed ? sign(rawBody) : undefined;
  if (sig !== undefined) headers["X-Razorpay-Signature"] = sig;

  const res = await fetch(URL, { method: "POST", headers, body: rawBody });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  console.log("=== Testing payment_link.paid Webhook Handling ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  // Snapshot initial collection counts
  const initialPaymentCount = await Payment.countDocuments();
  const initialAttemptCount = await RecoveryAttempt.countDocuments();

  // Clean up any leftovers from previous runs
  await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });
  await RecoveryAttempt.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

  try {
    // Seed test Payment in "failed" status
    const payment = await Payment.create({
      razorpayPaymentId: FAILED_PAYMENT_ID,
      razorpayOrderId: ORDER_ID,
      amount: 249900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Payment failed due to insufficient funds",
      customerEmail: "synthetic.payer@example.com",
      customerContact: "+919876543210",
    });

    // Seed test RecoveryAttempt in "executed" status with externalReference pointing to LINK_ID
    const attempt = await RecoveryAttempt.create({
      razorpayPaymentId: FAILED_PAYMENT_ID,
      razorpayOrderId: ORDER_ID,
      action: "CREATE_PAYMENT_LINK",
      status: "executed",
      amount: 249900,
      policyDecision: "ALLOW",
      policyReason: "Policy checks passed",
      externalReference: LINK_ID,
    });

    const attemptIdStr = String(attempt._id);

    console.log("--- 1. Security: Signature Verification ---");
    {
      const invalidSigRes = await postWebhook(
        { event: "payment_link.paid", payload: {} },
        { signature: "bad_signature_hex" }
      );
      check("invalid signature -> 401", invalidSigRes.status, 401);
      check("401 message is sanitized", invalidSigRes.body?.message, "Invalid webhook signature");

      const unsignedRes = await postWebhook(
        { event: "payment_link.paid", payload: {} },
        { signed: false }
      );
      check("missing signature header -> 401", unsignedRes.status, 401);
    }

    console.log("\n--- 2. Safe Acknowledgment: Missing / Invalid / Nonexistent reference_id ---");
    {
      // Missing reference_id
      const missingRefRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_ID,
              status: "paid",
              amount: 249900,
            },
          },
        },
      });
      check("missing reference_id -> 200 (safe ack)", missingRefRes.status, 200);
      check("acknowledged received: true", missingRefRes.body?.received, true);

      // Invalid reference_id (not an ObjectId)
      const invalidRefRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_ID,
              reference_id: "not-a-valid-objectid",
              status: "paid",
              amount: 249900,
            },
          },
        },
      });
      check("invalid reference_id -> 200 (safe ack)", invalidRefRes.status, 200);

      // Nonexistent ObjectId reference_id
      const nonexistentId = String(new mongoose.Types.ObjectId());
      const nonexistentRefRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_ID,
              reference_id: nonexistentId,
              status: "paid",
              amount: 249900,
            },
          },
        },
      });
      check("nonexistent reference_id -> 200 (safe ack)", nonexistentRefRes.status, 200);

      // Verify no changes occurred to our seeded payment or attempt
      const unchangedAttempt = await RecoveryAttempt.findById(attempt._id).lean();
      check("attempt status unchanged after invalid refs", unchangedAttempt.status, "executed");
      const unchangedPayment = await Payment.findById(payment._id).lean();
      check("payment status unchanged after invalid refs", unchangedPayment.status, "failed");
    }

    console.log("\n--- 3. Mismatched externalReference Guard (Rule 6) ---");
    {
      const mismatchRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: MISMATCHED_LINK_ID,
              reference_id: attemptIdStr,
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });
      check("mismatched link id -> 200 (safe ack)", mismatchRes.status, 200);

      const stillExecutedAttempt = await RecoveryAttempt.findById(attempt._id).lean();
      check("attempt status NOT updated on mismatch", stillExecutedAttempt.status, "executed");

      const stillFailedPayment = await Payment.findById(payment._id).lean();
      check("payment status NOT updated on mismatch", stillFailedPayment.status, "failed");
    }

    console.log("\n--- 4. Successful Recovery (Rule 5) ---");
    {
      const successPayload = {
        entity: "event",
        account_id: "acc_SYNTHETIC_001",
        event: "payment_link.paid",
        contains: ["payment_link", "payment", "order"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_ID,
              reference_id: attemptIdStr,
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
              order_id: ORDER_ID,
              short_url: "https://rzp.io/i/synthetic_secret_url",
            },
          },
          payment: {
            entity: {
              id: "pay_SYNTHETIC_LINKPAY_001",
              order_id: ORDER_ID,
              amount: 249900,
              status: "captured",
              email: "synthetic.payer@example.com",
              contact: "+919876543210",
            },
          },
          order: {
            entity: {
              id: ORDER_ID,
              amount: 249900,
            },
          },
        },
      };

      const successRes = await postWebhook(successPayload);
      check("payment_link.paid -> 200", successRes.status, 200);
      check("ack success is true", successRes.body?.success, true);
      check("ack received is true", successRes.body?.received, true);
      check("ack event is payment_link.paid", successRes.body?.event, "payment_link.paid");

      // Verify RecoveryAttempt updated to "succeeded"
      const updatedAttempt = await RecoveryAttempt.findById(attempt._id).lean();
      check("attempt status updated to 'succeeded'", updatedAttempt.status, "succeeded");
      check("attempt externalReference preserved", updatedAttempt.externalReference, LINK_ID);

      // Verify Payment updated to "recovered"
      const updatedPayment = await Payment.findById(payment._id).lean();
      check("payment status updated from 'failed' to 'recovered'", updatedPayment.status, "recovered");
    }

    console.log("\n--- 5. Idempotency on Duplicate Webhook Delivery ---");
    {
      // Re-send the identical successful webhook payload
      const dupRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_ID,
              reference_id: attemptIdStr,
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });
      check("duplicate delivery -> 200", dupRes.status, 200);

      const idempotentAttempt = await RecoveryAttempt.findById(attempt._id).lean();
      check("attempt status remains 'succeeded'", idempotentAttempt.status, "succeeded");

      const idempotentPayment = await Payment.findById(payment._id).lean();
      check("payment status remains 'recovered'", idempotentPayment.status, "recovered");
    }

    console.log("\n--- 6. Missing Original Payment: No Succeeded State ---");
    {
      const NONEXISTENT_PAYMENT_ID = `${SYNTHETIC_PREFIX}NONEXISTENT_999`;
      const LINK_NOPAY = "plink_SYNTHETIC_NOPAY_001";

      const attemptNoPay = await RecoveryAttempt.create({
        razorpayPaymentId: NONEXISTENT_PAYMENT_ID,
        razorpayOrderId: "order_SYNTHETIC_NOPAY",
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        amount: 249900,
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed",
        externalReference: LINK_NOPAY,
      });

      const res = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_NOPAY,
              reference_id: String(attemptNoPay._id),
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });

      check("missing payment -> 200 (safe ack)", res.status, 200);

      const checkAttempt = await RecoveryAttempt.findById(attemptNoPay._id).lean();
      check("attempt status is NOT succeeded (remains executed)", checkAttempt.status, "executed");

      const checkPayment = await Payment.findOne({ razorpayPaymentId: NONEXISTENT_PAYMENT_ID }).lean();
      check("no payment was created", checkPayment, null);
    }

    console.log("\n--- 7. Original Payment Already Not Failed: No Succeeded State ---");
    {
      const CAPTURED_PAYMENT_ID = `${SYNTHETIC_PREFIX}CAPTURED_001`;
      const LINK_CAP = "plink_SYNTHETIC_CAP_001";

      const capturedPayment = await Payment.create({
        razorpayPaymentId: CAPTURED_PAYMENT_ID,
        razorpayOrderId: "order_SYNTHETIC_CAP",
        amount: 249900,
        currency: "INR",
        status: "captured",
        method: "upi",
      });

      const attemptCap = await RecoveryAttempt.create({
        razorpayPaymentId: CAPTURED_PAYMENT_ID,
        razorpayOrderId: "order_SYNTHETIC_CAP",
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        amount: 249900,
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed",
        externalReference: LINK_CAP,
      });

      const res = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_CAP,
              reference_id: String(attemptCap._id),
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });

      check("payment not failed -> 200 (safe ack)", res.status, 200);

      const checkAttempt = await RecoveryAttempt.findById(attemptCap._id).lean();
      check("attempt status is NOT succeeded (remains executed)", checkAttempt.status, "executed");

      const checkPayment = await Payment.findById(capturedPayment._id).lean();
      check("payment status remains 'captured' (not recovered)", checkPayment.status, "captured");
    }

    console.log("\n--- 8. Retry Reconciliation: Payment='recovered' + RecoveryAttempt='executed' ---");
    {
      const RECOVERED_PAYMENT_ID = `${SYNTHETIC_PREFIX}RECOVERED_001`;
      const LINK_RETRY = "plink_SYNTHETIC_RETRY_001";

      const recoveredPayment = await Payment.create({
        razorpayPaymentId: RECOVERED_PAYMENT_ID,
        razorpayOrderId: "order_SYNTHETIC_RETRY",
        amount: 249900,
        currency: "INR",
        status: "recovered",
        method: "card",
      });

      const attemptRetry = await RecoveryAttempt.create({
        razorpayPaymentId: RECOVERED_PAYMENT_ID,
        razorpayOrderId: "order_SYNTHETIC_RETRY",
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        amount: 249900,
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed",
        externalReference: LINK_RETRY,
      });

      const res = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_RETRY,
              reference_id: String(attemptRetry._id),
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });

      check("retry on recovered payment -> 200", res.status, 200);
      check("ack success is true", res.body?.success, true);
      check("ack received is true", res.body?.received, true);

      const reconciledAttempt = await RecoveryAttempt.findById(attemptRetry._id).lean();
      check("attempt status reconciled from 'executed' to 'succeeded'", reconciledAttempt.status, "succeeded");

      const checkPayment = await Payment.findById(recoveredPayment._id).lean();
      check("payment status remains 'recovered'", checkPayment.status, "recovered");

      // Verify subsequent duplicate on now-succeeded attempt remains idempotent
      const dupRes = await postWebhook({
        entity: "event",
        event: "payment_link.paid",
        contains: ["payment_link"],
        payload: {
          payment_link: {
            entity: {
              id: LINK_RETRY,
              reference_id: String(attemptRetry._id),
              status: "paid",
              amount: 249900,
              amount_paid: 249900,
            },
          },
        },
      });
      check("subsequent duplicate after reconciliation -> 200", dupRes.status, 200);
      const stillSucceeded = await RecoveryAttempt.findById(attemptRetry._id).lean();
      check("attempt status remains 'succeeded' after dup", stillSucceeded.status, "succeeded");
    }

  } finally {
    // Teardown: Clean up all synthetic records created during testing
    console.log("\n--- Teardown & Cleanup ---");
    await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });
    await RecoveryAttempt.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

    const finalPaymentCount = await Payment.countDocuments();
    const finalAttemptCount = await RecoveryAttempt.countDocuments();

    check("Payment count restored cleanly", finalPaymentCount, initialPaymentCount);
    check("RecoveryAttempt count restored cleanly", finalAttemptCount, initialAttemptCount);

    await mongoose.disconnect();
  }

  console.log("\n" + (failures === 0 ? "PASS: All payment_link.paid webhook assertions passed successfully." : `FAIL: ${failures} assertion(s) failed.`));
  process.exit(failures === 0 ? 0 : 1);
})();

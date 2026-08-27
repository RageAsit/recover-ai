require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const { savePaymentFromEvent } = require("../services/paymentStore");

const FAILED_PAYMENT_ID = "pay_LINKTEST_FAILED_001";
const CAPTURED_PAYMENT_ID = "pay_LINKTEST_CAPTURED_002";
const ORDER_ID = "order_LINKTEST_001";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

(async () => {
  console.log("Testing Recovery Linkage by Order ID\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // Clean up any leftovers first
    await Payment.deleteMany({
      razorpayPaymentId: { $in: [FAILED_PAYMENT_ID, CAPTURED_PAYMENT_ID] },
    });

    // 1. Insert a failed payment
    await savePaymentFromEvent({
      event: "payment.failed",
      paymentId: FAILED_PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 249900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Insufficient funds",
    });

    const failedInitial = await Payment.findOne({ razorpayPaymentId: FAILED_PAYMENT_ID }).lean();
    check("1. initial failed payment status", failedInitial?.status, "failed");
    check("   initial failureReason preserved", failedInitial?.failureReason, "Insufficient funds");

    // 2. Feed a captured event with same orderId and different paymentId
    await savePaymentFromEvent({
      event: "payment.captured",
      paymentId: CAPTURED_PAYMENT_ID,
      orderId: ORDER_ID,
      amount: 249900,
      currency: "INR",
      status: "captured",
      method: "card",
      failureReason: null,
    });

    // 3. Assert failed doc flips to "recovered" and capture stores as "captured"
    const failedAfterCapture = await Payment.findOne({ razorpayPaymentId: FAILED_PAYMENT_ID }).lean();
    const capturedDoc = await Payment.findOne({ razorpayPaymentId: CAPTURED_PAYMENT_ID }).lean();

    check("2. original failed doc flipped to 'recovered'", failedAfterCapture?.status, "recovered");
    check("   original failureReason still intact", failedAfterCapture?.failureReason, "Insufficient funds");
    check("3. successful retry stored as 'captured'", capturedDoc?.status, "captured");

    // 4. Clean up temp docs
    await Payment.deleteMany({
      razorpayPaymentId: { $in: [FAILED_PAYMENT_ID, CAPTURED_PAYMENT_ID] },
    });
    const remainingCount = await Payment.countDocuments({
      razorpayPaymentId: { $in: [FAILED_PAYMENT_ID, CAPTURED_PAYMENT_ID] },
    });
    check("4. temp documents cleaned up", remainingCount, 0);
  } catch (err) {
    console.error("Error during test execution:", err.message);
    process.exitCode = 1;
  } finally {
    await Payment.deleteMany({
      razorpayPaymentId: { $in: [FAILED_PAYMENT_ID, CAPTURED_PAYMENT_ID] },
    });
    await mongoose.disconnect();
  }

  console.log("");
  console.log(failures === 0 && !process.exitCode ? "PASS: all recovery linkage checks passed" : `FAIL: ${failures} check(s) failed`);
  process.exit(failures === 0 && !process.exitCode ? 0 : 1);
})();

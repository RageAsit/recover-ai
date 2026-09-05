require("dotenv").config();
const mongoose = require("mongoose");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const TEST_PAYMENT_ID = "pay_SYNTHETIC_RECOVERY_ATTEMPT_001";
const INVALID_PAYMENT_ID = "pay_SYNTHETIC_RECOVERY_ATTEMPT_INVALID";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${shown}`);
}

(async () => {
  console.log("Testing RecoveryAttempt Model\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // Clean up any stale test documents first
    await RecoveryAttempt.deleteMany({
      razorpayPaymentId: { $in: [TEST_PAYMENT_ID, INVALID_PAYMENT_ID] },
    });

    // 1. Insert one document with all fields populated
    const sampleData = {
      razorpayPaymentId: TEST_PAYMENT_ID,
      razorpayOrderId: "order_SYNTHETIC_001",
      action: "CREATE_PAYMENT_LINK",
      status: "pending",
      amount: 249900,
      llmReason: "Card was declined due to insufficient funds for a first-time customer.",
      llmConfidence: 0.85,
      policyDecision: "ALLOW",
      policyReason: "First-time failure under risk threshold.",
      modelVersion: "models/gemini-3.6-flash",
      responseId: "resp_test_12345",
      externalReference: "plink_test_98765",
    };

    const createdDoc = await RecoveryAttempt.create(sampleData);
    console.log("A. Document Creation & Field Types");
    check("document created with _id", typeof createdDoc._id.toString(), "string");

    // Read it back from the database
    const readDoc = await RecoveryAttempt.findOne({ razorpayPaymentId: TEST_PAYMENT_ID }).lean();

    check("razorpayPaymentId is string", typeof readDoc?.razorpayPaymentId, "string");
    check("razorpayPaymentId value", readDoc?.razorpayPaymentId, TEST_PAYMENT_ID);
    check("razorpayOrderId is string", typeof readDoc?.razorpayOrderId, "string");
    check("razorpayOrderId value", readDoc?.razorpayOrderId, "order_SYNTHETIC_001");
    check("action is valid enum string", readDoc?.action, "CREATE_PAYMENT_LINK");
    check("status defaults/persists correctly", readDoc?.status, "pending");
    check("amount is number", typeof readDoc?.amount, "number");
    check("amount value (paise)", readDoc?.amount, 249900);
    check("llmReason is string", typeof readDoc?.llmReason, "string");
    check("llmConfidence is number", typeof readDoc?.llmConfidence, "number");
    check("llmConfidence value", readDoc?.llmConfidence, 0.85);
    check("policyDecision is valid enum string", readDoc?.policyDecision, "ALLOW");
    check("policyReason is string", typeof readDoc?.policyReason, "string");
    check("modelVersion is string", typeof readDoc?.modelVersion, "string");
    check("responseId is string", typeof readDoc?.responseId, "string");
    check("externalReference is string", typeof readDoc?.externalReference, "string");
    check("createdAt is date/instance", Boolean(readDoc?.createdAt), true);
    check("updatedAt is date/instance", Boolean(readDoc?.updatedAt), true);

    // 2. Enum rejection test for invalid action
    console.log("\nB. Schema Validation (Enum Enforcement)");
    let invalidActionRejected = false;
    try {
      await RecoveryAttempt.create({
        razorpayPaymentId: INVALID_PAYMENT_ID,
        action: "INVALID_ACTION_NAME",
      });
    } catch (err) {
      if (err.name === "ValidationError" && err.errors?.action) {
        invalidActionRejected = true;
      }
    }
    check("invalid action rejected by enum", invalidActionRejected, true);
  } catch (err) {
    console.error("Error during test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // Delete the test documents
    await RecoveryAttempt.deleteMany({
      razorpayPaymentId: { $in: [TEST_PAYMENT_ID, INVALID_PAYMENT_ID] },
    });
    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: RecoveryAttempt model verified successfully.");
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

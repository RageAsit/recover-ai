require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const { buildPaymentContext } = require("../services/paymentContext");

(async () => {
  console.log("Testing buildPaymentContext and PII Exclusion\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // Find an existing payment document in the database
    const existingDoc = await Payment.findOne().sort({ createdAt: -1 }).lean();

    if (!existingDoc) {
      console.error("ABORT: No payment documents found in database to test against.");
      process.exitCode = 1;
      return;
    }

    console.log(`Found existing payment: ${existingDoc.razorpayPaymentId}`);
    const context = await buildPaymentContext(existingDoc.razorpayPaymentId);

    console.log("\n=== ASSEMBLED PAYMENT CONTEXT ===");
    console.log(JSON.stringify(context, null, 2));
    console.log("");

    const contextJson = JSON.stringify(context);

    // PII Checks
    let piiViolations = 0;

    const hasAtSymbol = contextJson.includes("@");
    if (hasAtSymbol) {
      console.error("FAIL: JSON contains '@' (potential email leakage)");
      piiViolations++;
    } else {
      console.log("ok   no '@' found in context JSON");
    }

    const tenDigitMatch = contextJson.match(/\d{10}/);
    if (tenDigitMatch) {
      console.error(`FAIL: JSON contains 10-digit number sequence: ${tenDigitMatch[0]} (potential phone/contact leakage)`);
      piiViolations++;
    } else {
      console.log("ok   no 10-digit run found in context JSON");
    }

    console.log("");
    if (piiViolations === 0) {
      console.log("PASS: PII check passed. Object is safe for LLM context.");
    } else {
      console.error(`FAIL: PII check failed with ${piiViolations} violation(s).`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Error during test execution:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

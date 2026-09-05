require("dotenv").config();
const mongoose = require("mongoose");
const RecoveryAttempt = require("../models/RecoveryAttempt");

const isApply = process.argv.includes("--apply");
const isPurge = process.argv.includes("--purge");

// Purge matches a POSITIVE synthetic marker. It must never be defined as
// "everything that doesn't look real". Over-deleting here destroys the audit
// trail for real payments, so an unrecognised id must be KEPT by default -
// the opposite of the exclusion-list choice in recoveryHistory.js, because
// there the unsafe direction was under-counting and here it is over-deleting.
const SYNTHETIC_ID_PREFIX = /^pay_SYNTHETIC/;

// 6 Synthetic RecoveryAttempt rows spread across allowed / executed / denied / human_review / failed
// with varied amounts and realistic policyReason text.
// CRITICAL: SYNTHETIC payment and order IDs only! Never real ones.
const timestamp = Date.now();
const SYNTHETIC_SEED_ROWS = [
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_001",
    razorpayOrderId: "order_SYNTHETIC_DEV_001",
    amount: 249900, // Rs 2,499.00
    action: "CREATE_PAYMENT_LINK",
    status: "executed",
    policyDecision: "ALLOW",
    policyReason: "Policy checks passed: within amount threshold and attempt budget",
    llmReason: "Customer has strong historical capture rate; dispatching recovery payment link via SMS",
    llmConfidence: 0.93,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_001`,
    externalReference: "plink_dev_seed_001",
    executionError: null,
    createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
  },
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_002",
    razorpayOrderId: "order_SYNTHETIC_DEV_002",
    amount: 129900, // Rs 1,299.00
    action: "CREATE_PAYMENT_LINK",
    status: "allowed",
    policyDecision: "ALLOW",
    policyReason: "Policy checks passed: first recovery attempt on order",
    llmReason: "Transient bank network timeout; high probability of successful retry link",
    llmConfidence: 0.88,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_002`,
    externalReference: null,
    executionError: null,
    createdAt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
  },
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_003",
    razorpayOrderId: "order_SYNTHETIC_DEV_003",
    amount: 89900, // Rs 899.00
    action: "STOP",
    status: "denied",
    policyDecision: "DENY",
    policyReason: "Maximum recovery attempts exceeded for order",
    llmReason: "Card repeatedly declined by issuer; budget exhausted",
    llmConfidence: 0.81,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_003`,
    externalReference: null,
    executionError: null,
    createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
  },
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_004",
    razorpayOrderId: "order_SYNTHETIC_DEV_004",
    amount: 550000, // Rs 5,500.00 (> 400000 limit)
    action: "HUMAN_REVIEW",
    status: "human_review",
    policyDecision: "HUMAN_REVIEW",
    policyReason: "Payment amount exceeds automated recovery threshold",
    llmReason: "High ticket order with prior chargeback; manual review required",
    llmConfidence: 0.74,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_004`,
    externalReference: null,
    executionError: null,
    createdAt: new Date(Date.now() - 45 * 60 * 1000), // 45 minutes ago
  },
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_005",
    razorpayOrderId: "order_SYNTHETIC_DEV_005",
    amount: 199900, // Rs 1,999.00
    action: "CREATE_PAYMENT_LINK",
    status: "failed",
    policyDecision: "ALLOW",
    policyReason: "Policy checks passed",
    llmReason: "UPI payment expired; recommended recovery link creation",
    llmConfidence: 0.86,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_005`,
    externalReference: null,
    executionError: "No contact details available at dispatch time",
    createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
  },
  {
    razorpayPaymentId: "pay_SYNTHETIC_DEV_006",
    razorpayOrderId: "order_SYNTHETIC_DEV_006",
    amount: 349900, // Rs 3,499.00
    action: "CREATE_PAYMENT_LINK",
    status: "executed",
    policyDecision: "ALLOW",
    policyReason: "Policy checks passed: returning customer with successful history",
    llmReason: "Card limit exceeded; dispatching recovery payment link via SMS",
    llmConfidence: 0.94,
    modelVersion: "gemini-3.6-flash",
    responseId: `resp_seed_${timestamp}_006`,
    externalReference: "plink_dev_seed_006",
    executionError: null,
    createdAt: new Date(Date.now() - 90 * 60 * 1000), // 1.5 hours ago
  },
];

(async () => {
  console.log("================================================================================");
  console.log("RecoverAI: Dev Activity Data Seeder");
  console.log("================================================================================\n");

  // Print reminder on every single run
  console.log("--------------------------------------------------------------------------------");
  console.log("REMINDER: Any synthetic seed data MUST be purged before running a live demo!");
  console.log("To purge synthetic records, run: node scripts/seedActivityData.js --purge --apply");
  console.log("--------------------------------------------------------------------------------\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // -------------------------------------------------------------------------
    // PURGE MODE
    // -------------------------------------------------------------------------
    if (isPurge) {
      console.log("=== PURGE MODE ===");
      const totalCount = await RecoveryAttempt.countDocuments();
      const syntheticDocs = await RecoveryAttempt.find({
        razorpayPaymentId: SYNTHETIC_ID_PREFIX,
      }).lean();

      if (syntheticDocs.length === totalCount && totalCount > 0) {
        console.log(
          "WARNING: purge would delete every document in the collection - verify this is a clean dev database."
        );
      }

      console.log(`Found ${syntheticDocs.length} synthetic RecoveryAttempt document(s) for purge:`);
      if (syntheticDocs.length === 0) {
        console.log("  (no synthetic documents found in database)\n");
      } else {
        syntheticDocs.forEach((doc, idx) => {
          console.log(
            `  ${idx + 1}. paymentId=${doc.razorpayPaymentId.padEnd(26)} status=${doc.status.padEnd(14)} amount=₹${(
              (doc.amount || 0) / 100
            ).toFixed(2)}`
          );
        });
        console.log("");
      }

      if (!isApply) {
        console.log("--------------------------------------------------------------------------------");
        console.log("DRY RUN: --purge specified WITHOUT --apply. No documents were deleted.");
        console.log("To perform actual deletion, run:");
        console.log("  node scripts/seedActivityData.js --purge --apply");
        console.log("--------------------------------------------------------------------------------\n");
      } else {
        const result = await RecoveryAttempt.deleteMany({
          razorpayPaymentId: SYNTHETIC_ID_PREFIX,
        });
        console.log(`SUCCESS: Purged ${result.deletedCount} synthetic RecoveryAttempt document(s) from database.\n`);
      }

      return;
    }

    // -------------------------------------------------------------------------
    // SEED MODE (Dry Run by default, --apply to write)
    // -------------------------------------------------------------------------
    if (!isApply) {
      console.log("=== DRY RUN MODE (Default: No database writes) ===\n");
      console.log("6 synthetic RecoveryAttempt records that WOULD be seeded:");
      SYNTHETIC_SEED_ROWS.forEach((row, idx) => {
        console.log(
          `  ${idx + 1}. ${row.razorpayPaymentId.padEnd(26)} | Status: ${row.status.padEnd(14)} | Amount: ₹${(
            row.amount / 100
          )
            .toFixed(2)
            .padStart(8)} | Action: ${row.action.padEnd(20)} | Policy: ${row.policyDecision}`
        );
        console.log(`     Policy Reason: ${row.policyReason}`);
      });

      console.log("\n--------------------------------------------------------------------------------");
      console.log("DRY RUN COMPLETE: 0 documents written to database.");
      console.log("To insert these records into the database for UI testing, run:");
      console.log("  node scripts/seedActivityData.js --apply");
      console.log("--------------------------------------------------------------------------------\n");
    } else {
      console.log("=== APPLY MODE: Writing seed records to database ===\n");

      // First clean up any existing rows with these exact seed IDs to avoid duplicates
      const seedPaymentIds = SYNTHETIC_SEED_ROWS.map((r) => r.razorpayPaymentId);
      await RecoveryAttempt.deleteMany({ razorpayPaymentId: { $in: seedPaymentIds } });

      const inserted = await RecoveryAttempt.insertMany(SYNTHETIC_SEED_ROWS);
      console.log(`SUCCESS: Inserted ${inserted.length} synthetic RecoveryAttempt records into database:\n`);
      inserted.forEach((doc, idx) => {
        const iso = doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString();
        console.log(
          `  ${idx + 1}. ${doc.razorpayPaymentId.padEnd(26)} | Status: ${doc.status.padEnd(14)} | Amount: ₹${(
            (doc.amount || 0) / 100
          ).toFixed(2)} | createdAt: ${iso}`
        );
      });
      console.log("");

      const times = inserted.map((d) => new Date(d.createdAt).getTime());
      const oldest = Math.min(...times);
      const newest = Math.max(...times);
      const spanSeconds = Math.round((newest - oldest) / 1000);

      console.log(`createdAt span across seeded rows: ${spanSeconds} seconds`);
      if (spanSeconds > 60) {
        console.log("TIMESTAMPS PRESERVED: staggered createdAt survived insertMany.\n");
      } else {
        console.log(
          "TIMESTAMPS OVERWRITTEN: Mongoose timestamps:true replaced the supplied createdAt values. Activity feed ordering will be arbitrary.\n"
        );
      }
    }
  } catch (err) {
    console.error("Error during seedActivityData execution:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

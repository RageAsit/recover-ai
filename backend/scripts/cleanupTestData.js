require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const { getDashboardStats } = require("../services/dashboardStats");

const EXPLICIT_PURGE_IDS = Object.freeze([
  "pay_RACETEST001",
  "pay_TESTFAILED001",
  "pay_TESTCAPTURED001",
  "pay_FRESH01",
]);

const PHANTOM_SEED_QUERY = Object.freeze({ status: "recovered", amount: 500000 });

function printTable(docs) {
  if (docs.length === 0) {
    console.log("  (Collection is empty)");
    return;
  }
  const rows = docs.map((d) => ({
    "Payment ID": d.razorpayPaymentId,
    "Status": d.status,
    "Amount (paise)": d.amount,
    "Order ID": d.razorpayOrderId || "(none)",
  }));
  console.table(rows);
}

function printStats(label, stats) {
  console.log(`${label}:`);
  console.log(`  Revenue at Risk:     ${stats.revenueAtRisk} paise`);
  console.log(`  Revenue Recovered:   ${stats.revenueRecovered} paise`);
  console.log(`  Recovery Rate:       ${stats.recoveryRate}%`);
}

(async () => {
  const isApply = process.argv.includes("--apply");
  const modeLabel = isApply ? "APPLY (LIVE EXECUTION)" : "DRY RUN (NO CHANGES)";

  console.log(`=== RecoverAI Data Cleanup [${modeLabel}] ===\n`);

  if (!process.env.MONGODB_URI) {
    console.error("Error: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // 1. Current Collection State
    const currentDocs = await Payment.find({}).sort({ createdAt: 1 }).lean();
    console.log(`Current documents in collection (${currentDocs.length}):`);
    printTable(currentDocs);
    console.log("");

    // Current metrics
    const statsBefore = await getDashboardStats();
    printStats("Current Dashboard Metrics", statsBefore);
    console.log("");

    // 2. BACKFILL: Find failed payments that share razorpayOrderId with a captured payment
    console.log("--- 1. BACKFILL ANALYSIS ---");
    const failedDocs = await Payment.find({
      status: "failed",
      razorpayOrderId: { $exists: true, $ne: null },
    }).lean();

    const backfillCandidates = [];

    for (const failedDoc of failedDocs) {
      const capturedPartner = await Payment.findOne({
        razorpayOrderId: failedDoc.razorpayOrderId,
        status: "captured",
        razorpayPaymentId: { $ne: failedDoc.razorpayPaymentId },
      }).lean();

      if (capturedPartner) {
        backfillCandidates.push({
          paymentId: failedDoc.razorpayPaymentId,
          orderId: failedDoc.razorpayOrderId,
          amount: failedDoc.amount,
          matchingCaptureId: capturedPartner.razorpayPaymentId,
        });
      }
    }

    if (backfillCandidates.length === 0) {
      console.log("  No failed payments eligible for backfill.");
    } else {
      console.log(`  Found ${backfillCandidates.length} document(s) to backfill to 'recovered':`);
      for (const item of backfillCandidates) {
        console.log(`    - ${item.paymentId} (orderId: ${item.orderId}, matched capture: ${item.matchingCaptureId})`);
      }

      if (isApply) {
        const backfillIds = backfillCandidates.map((c) => c.paymentId);
        const res = await Payment.updateMany(
          { razorpayPaymentId: { $in: backfillIds } },
          { $set: { status: "recovered" } }
        );
        console.log(`  -> APPLIED: Updated ${res.modifiedCount} document(s) to 'recovered'.`);
      } else {
        console.log("  -> DRY RUN: No documents modified.");
      }
    }
    console.log("");

    // 3. PURGE ANALYSIS
    console.log("--- 2. PURGE ANALYSIS ---");
    const explicitDocs = await Payment.find({
      razorpayPaymentId: { $in: EXPLICIT_PURGE_IDS },
    }).lean();

    const explicitFoundIds = explicitDocs.map((d) => d.razorpayPaymentId);
    console.log(`  Explicit test IDs target list: ${EXPLICIT_PURGE_IDS.join(", ")}`);
    console.log(`  Found in collection (${explicitFoundIds.length}): ${explicitFoundIds.join(", ") || "(none)"}`);

    // Phantom seed check
    const phantomDocs = await Payment.find(PHANTOM_SEED_QUERY).lean();
    console.log(`  Query for phantom seed { status: "recovered", amount: 500000 }: found ${phantomDocs.length} document(s)`);

    if (phantomDocs.length !== 1) {
      console.error(
        `\nABORT: Expected exactly 1 document matching { status: "recovered", amount: 500000 }, but found ${phantomDocs.length}. Purge cannot proceed safely.`
      );
      return;
    }

    const phantomDoc = phantomDocs[0];
    console.log(`    - Phantom seed ID: ${phantomDoc.razorpayPaymentId} (orderId: ${phantomDoc.razorpayOrderId || "none"}, amount: ${phantomDoc.amount})`);

    const allIdsToDelete = [...new Set([...explicitFoundIds, phantomDoc.razorpayPaymentId])];
    console.log(`  Total documents targeted for deletion (${allIdsToDelete.length}):`);
    for (const id of allIdsToDelete) {
      console.log(`    - ${id}`);
    }

    if (isApply) {
      const deleteRes = await Payment.deleteMany({
        razorpayPaymentId: { $in: allIdsToDelete },
      });
      console.log(`  -> APPLIED: Deleted ${deleteRes.deletedCount} document(s).`);
    } else {
      console.log("  -> DRY RUN: No documents deleted.");
    }
    console.log("");

    // 4. Metrics After (if applied)
    if (isApply) {
      console.log("--- 3. POST-CLEANUP STATE ---");
      const postDocs = await Payment.find({}).sort({ createdAt: 1 }).lean();
      console.log(`Remaining documents in collection (${postDocs.length}):`);
      printTable(postDocs);
      console.log("");

      const statsAfter = await getDashboardStats();
      printStats("Updated Dashboard Metrics", statsAfter);
      console.log("");
    }

    console.log(`=== Cleanup completed [${modeLabel}] ===`);
  } catch (err) {
    console.error("Error during cleanup execution:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

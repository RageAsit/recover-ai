require("dotenv").config();
const mongoose = require("mongoose");
const RecoveryAttempt = require("../models/RecoveryAttempt");
const { getRecoveryActivity } = require("../services/recoveryActivity");

const EXPECTED_KEYS = [
  "action",
  "amount",
  "createdAt",
  "executionError",
  "externalReference",
  "id",
  "llmConfidence",
  "llmReason",
  "modelVersion",
  "policyDecision",
  "policyReason",
  "razorpayOrderId",
  "razorpayPaymentId",
  "responseId",
  "status",
].sort();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(60)} ${shown}`);
}

(async () => {
  console.log("=== Recovery Attempt Inventory & Activity Service Verification ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("ABORT: MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const timestamp = Date.now();
  const SEED_PAYMENT_1 = `pay_SYNTHETIC_ACT_EXEC_${timestamp}`;
  const SEED_PAYMENT_2 = `pay_SYNTHETIC_ACT_DENIED_${timestamp}`;
  const SEED_PAYMENT_3 = `pay_SYNTHETIC_ACT_HR_${timestamp}`;
  const SEEDED_IDS = [SEED_PAYMENT_1, SEED_PAYMENT_2, SEED_PAYMENT_3];

  let startingCount = 0;

  try {
    // -------------------------------------------------------------------------
    // 1. Full Inventory of RecoveryAttempt Collection (Pre-Seed State)
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("FULL INVENTORY: RecoveryAttempt Collection (Pre-Seed State)");
    console.log("--------------------------------------------------------------------------------");

    startingCount = await RecoveryAttempt.countDocuments();
    const allAttempts = await RecoveryAttempt.find({}).sort({ createdAt: -1 }).lean();
    console.log(`Total documents found: ${allAttempts.length}\n`);

    if (allAttempts.length === 0) {
      console.log("  [Inventory is empty: 0 documents currently in RecoveryAttempt collection]\n");
    } else {
      const inventoryRows = allAttempts.map((doc, idx) => {
        // Real Razorpay payment IDs are "pay_" followed by exactly 14 alphanumeric characters
        const isReal = /^pay_[a-zA-Z0-9]{14}$/.test(doc.razorpayPaymentId);
        return {
          "#": idx + 1,
          id: String(doc._id),
          paymentId: doc.razorpayPaymentId,
          status: doc.status,
          createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : "N/A",
          type: isReal ? "REAL" : "SYNTHETIC",
        };
      });
      console.table(inventoryRows);
      console.log("");
    }

    // -------------------------------------------------------------------------
    // 2. SEED 3 distinct shapes directly
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SEEDING: 3 Direct RecoveryAttempt Documents for Non-Vacuous Verification");
    console.log("--------------------------------------------------------------------------------");

    await RecoveryAttempt.create([
      {
        razorpayPaymentId: SEED_PAYMENT_1,
        razorpayOrderId: `order_SYNTHETIC_EXEC_${timestamp}`,
        amount: 250000,
        action: "CREATE_PAYMENT_LINK",
        status: "executed",
        policyDecision: "ALLOW",
        policyReason: "Policy checks passed: first attempt approved",
        llmReason: "Transient bank gateway error; high recovery propensity",
        llmConfidence: 0.95,
        modelVersion: "gemini-3.6-flash",
        responseId: `resp_${timestamp}_1`,
        externalReference: `plink_${timestamp}_001`,
        // executionError unset
      },
      {
        razorpayPaymentId: SEED_PAYMENT_2,
        razorpayOrderId: `order_SYNTHETIC_DENIED_${timestamp}`,
        amount: 150000,
        action: "STOP",
        status: "denied",
        policyDecision: "DENY",
        policyReason: "Maximum recovery attempts exceeded for order",
        llmReason: "Order already reached maximum budget",
        llmConfidence: 0.89,
        modelVersion: "gemini-3.6-flash",
        responseId: `resp_${timestamp}_2`,
        // externalReference unset
        // executionError unset
      },
      {
        razorpayPaymentId: SEED_PAYMENT_3,
        razorpayOrderId: `order_SYNTHETIC_HR_${timestamp}`,
        amount: 750000,
        action: "HUMAN_REVIEW",
        status: "human_review",
        policyDecision: "HUMAN_REVIEW",
        policyReason: "Payment amount exceeds automated recovery threshold",
        llmReason: "High ticket order flagged for supervisor review",
        llmConfidence: 0.72,
        modelVersion: "gemini-3.6-flash",
        responseId: `resp_${timestamp}_3`,
        // externalReference unset
        // executionError unset
      },
    ]);

    console.log("Seeded 3 synthetic RecoveryAttempt documents:");
    console.log(`  1. ${SEED_PAYMENT_1} (executed, ALLOW, externalReference set, executionError unset)`);
    console.log(`  2. ${SEED_PAYMENT_2} (denied, DENY, action STOP)`);
    console.log(`  3. ${SEED_PAYMENT_3} (human_review, HUMAN_REVIEW, action HUMAN_REVIEW)\n`);

    // -------------------------------------------------------------------------
    // 3. SERVICE ASSERTIONS: Guarded Non-Vacuous Verification
    // -------------------------------------------------------------------------
    console.log("--------------------------------------------------------------------------------");
    console.log("SERVICE ASSERTIONS: getRecoveryActivity (Guarded Against Empty Arrays)");
    console.log("--------------------------------------------------------------------------------");

    const activities = await getRecoveryActivity({ limit: 50 });

    // GUARD: fail loudly if array is empty
    check("returned array length is greater than 0", activities.length > 0, true);
    if (activities.length === 0) {
      throw new Error("GUARD FAILED: getRecoveryActivity returned 0 items. Cannot verify allowlist on empty collection.");
    }

    // Filter to only our seeded documents to assert their specific shapes
    const seededActivities = activities.filter((a) => SEEDED_IDS.includes(a.razorpayPaymentId));
    check("all 3 seeded documents present in activity output", seededActivities.length, 3);
    if (seededActivities.length !== 3) {
      throw new Error(`GUARD FAILED: expected 3 seeded documents in activity, found ${seededActivities.length}`);
    }

    // Assert allowlist and PII exclusion per document
    for (const item of seededActivities) {
      const keys = Object.keys(item).sort();
      check(`item [${item.status}] has exactly 15 allowlisted keys`, keys, EXPECTED_KEYS);
      check(`item [${item.status}] allowlist key count is 15`, keys.length, 15);
      check(`item [${item.status}] JSON has no 'customerEmail'`, JSON.stringify(item).includes("customerEmail"), false);
      check(`item [${item.status}] JSON has no 'customerContact'`, JSON.stringify(item).includes("customerContact"), false);
    }

    // Shape-specific assertions
    console.log("\nShape-Specific Assertions");
    const execDoc = seededActivities.find((a) => a.razorpayPaymentId === SEED_PAYMENT_1);
    check("executed doc status is 'executed'", execDoc?.status, "executed");
    check("executed doc policyDecision is 'ALLOW'", execDoc?.policyDecision, "ALLOW");
    check(
      "executed doc externalReference starts with 'plink_'",
      typeof execDoc?.externalReference === "string" && execDoc.externalReference.startsWith("plink_"),
      true
    );
    check("executed doc executionError is null/unset", execDoc?.executionError, null);

    const deniedDoc = seededActivities.find((a) => a.razorpayPaymentId === SEED_PAYMENT_2);
    check("denied doc status is 'denied'", deniedDoc?.status, "denied");
    check("denied doc policyDecision is 'DENY'", deniedDoc?.policyDecision, "DENY");
    check("denied doc action is 'STOP'", deniedDoc?.action, "STOP");

    const hrDoc = seededActivities.find((a) => a.razorpayPaymentId === SEED_PAYMENT_3);
    check("human_review doc status is 'human_review'", hrDoc?.status, "human_review");
    check("human_review doc policyDecision is 'HUMAN_REVIEW'", hrDoc?.policyDecision, "HUMAN_REVIEW");
    check("human_review doc action is 'HUMAN_REVIEW'", hrDoc?.action, "HUMAN_REVIEW");

    // Limit and clamping tests
    console.log("\nLimit and Clamping Verification");
    const limit2 = await getRecoveryActivity({ limit: 2 });
    check("limit of 2 returns at most 2 items", limit2.length <= 2, true);

    // Spy on RecoveryAttempt.find to verify limit 9999 is clamped to 200
    let capturedLimit = null;
    const origFind = RecoveryAttempt.find;
    RecoveryAttempt.find = function (...args) {
      const query = origFind.apply(this, args);
      const originalLimit = query.limit;
      query.limit = function (num) {
        capturedLimit = num;
        return originalLimit.apply(this, arguments);
      };
      return query;
    };
    await getRecoveryActivity({ limit: 9999 });
    RecoveryAttempt.find = origFind; // restore immediately
    check("limit of 9999 is clamped to 200", capturedLimit, 200);

  } catch (err) {
    console.error("Error during recovery activity test execution:", err.message);
    process.exitCode = 1;
  } finally {
    // -------------------------------------------------------------------------
    // 4. CLEANUP: Delete all three seeded documents and assert starting count
    // -------------------------------------------------------------------------
    console.log("\n--------------------------------------------------------------------------------");
    console.log("CLEANUP & RESTORATION VERIFICATION");
    console.log("--------------------------------------------------------------------------------");

    await RecoveryAttempt.deleteMany({ razorpayPaymentId: { $in: SEEDED_IDS } });
    const finalCount = await RecoveryAttempt.countDocuments();
    console.log(`Starting count: ${startingCount}`);
    console.log(`Final count:    ${finalCount}`);
    check("RecoveryAttempt count returned to starting value", finalCount, startingCount);

    await mongoose.disconnect();
  }

  console.log("");
  if (failures === 0 && !process.exitCode) {
    console.log("PASS: testRecoveryActivity verified with non-vacuous assertions and proven cleanup.");
    process.exit(0);
  } else {
    console.error(`FAIL: ${failures} check(s) failed.`);
    process.exit(1);
  }
})();

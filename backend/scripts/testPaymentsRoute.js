/**
 * Focused tests for GET /api/payments
 *
 * Verifies:
 * - Default / All statuses response
 * - Status filters: failed, captured, recovered, all
 * - Newest-first ordering
 * - Limit query parameter and clamping
 * - Invalid query parameters (status, limit) -> 400
 * - Exact allowlisted response shape (no PII or raw provider payloads)
 * - Clean self-verifying teardown
 *
 * Usage:
 *   node scripts/testPaymentsRoute.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Payment = require("../models/Payment");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const URL = `${BASE_URL}/api/payments`;

const SYNTHETIC_PREFIX = "pay_SYNTHETIC_PAYTEST_";
const FAILED_ID = `${SYNTHETIC_PREFIX}FAILED_001`;
const CAPTURED_ID = `${SYNTHETIC_PREFIX}CAPTURED_002`;
const RECOVERED_ID = `${SYNTHETIC_PREFIX}RECOVERED_003`;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${shown}`);
}

async function fetchPayments(queryString = "") {
  const fullUrl = `${URL}${queryString ? `?${queryString}` : ""}`;
  const res = await fetch(fullUrl);
  const rawText = await res.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch {}
  return { status: res.status, body: json, rawText };
}

(async () => {
  console.log("=== Testing Payments Endpoint (GET /api/payments) ===\n");

  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not found in environment");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const initialCount = await Payment.countDocuments();

  // Clean up any leftovers
  await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

  try {
    // Seed synthetic payments across all statuses with staggered timestamps
    await Payment.create({
      razorpayPaymentId: FAILED_ID,
      razorpayOrderId: "order_SYNTHETIC_PTEST_001",
      amount: 149900,
      currency: "INR",
      status: "failed",
      method: "card",
      failureReason: "Card expired",
      customerEmail: "leaked_failed@example.com",
      customerContact: "+919876543211",
      createdAt: new Date(Date.now() - 180000), // 3 mins ago
    });

    await Payment.create({
      razorpayPaymentId: CAPTURED_ID,
      razorpayOrderId: "order_SYNTHETIC_PTEST_002",
      amount: 249900,
      currency: "INR",
      status: "captured",
      method: "upi",
      customerEmail: "leaked_captured@example.com",
      customerContact: "+919876543212",
      createdAt: new Date(Date.now() - 120000), // 2 mins ago
    });

    await Payment.create({
      razorpayPaymentId: RECOVERED_ID,
      razorpayOrderId: "order_SYNTHETIC_PTEST_003",
      amount: 349900,
      currency: "INR",
      status: "recovered",
      method: "netbanking",
      customerEmail: "leaked_recovered@example.com",
      customerContact: "+919876543213",
      createdAt: new Date(Date.now() - 60000), // 1 min ago (newest)
    });

    console.log("--- 1. Default Query / All Statuses & Allowlist ---");
    {
      const res = await fetchPayments();
      check("status is 200", res.status, 200);
      check("success is true", res.body?.success, true);
      check("count is a number", typeof res.body?.count, "number");
      check("payments is an array", Array.isArray(res.body?.payments), true);

      // PII exclusions
      check("raw text has no customerEmail", res.rawText.includes("customerEmail"), false);
      check("raw text has no customerContact", res.rawText.includes("customerContact"), false);
      check("raw text has no leaked email address", res.rawText.includes("leaked_"), false);
      check("raw text has no phone numbers", res.rawText.includes("+91987654321"), false);
      check("raw text has no short URLs", res.rawText.includes("shortUrl"), false);

      // Seeded IDs are present
      const returnedIds = (res.body?.payments || []).map((p) => p.id);
      check("recovered synthetic ID present", returnedIds.includes(RECOVERED_ID), true);
      check("captured synthetic ID present", returnedIds.includes(CAPTURED_ID), true);
      check("failed synthetic ID present", returnedIds.includes(FAILED_ID), true);

      // Verify newest-first ordering among synthetic IDs
      const idxRecovered = returnedIds.indexOf(RECOVERED_ID);
      const idxCaptured = returnedIds.indexOf(CAPTURED_ID);
      const idxFailed = returnedIds.indexOf(FAILED_ID);
      check("newest (recovered) appears before captured", idxRecovered < idxCaptured, true);
      check("captured appears before oldest (failed)", idxCaptured < idxFailed, true);

      // Verify exact 9-key allowlist on payment item
      const item = res.body?.payments?.[0];
      check("exact allowlist keys (9 fields)", Object.keys(item).sort(), [
        "amount", "createdAt", "currency", "failureReason", "id", "method", "orderId", "status", "updatedAt"
      ]);
    }

    console.log("\n--- 2. Status Filters ---");
    {
      // Filter: failed
      const failedRes = await fetchPayments("status=failed");
      check("status=failed -> 200", failedRes.status, 200);
      const failedIds = (failedRes.body?.payments || []).map((p) => p.id);
      check("failed filter includes failed ID", failedIds.includes(FAILED_ID), true);
      check("failed filter excludes captured ID", failedIds.includes(CAPTURED_ID), false);
      check("failed filter excludes recovered ID", failedIds.includes(RECOVERED_ID), false);
      const allFailed = (failedRes.body?.payments || []).every((p) => p.status === "failed");
      check("all returned rows have status 'failed'", allFailed, true);

      // Filter: captured
      const capRes = await fetchPayments("status=captured");
      check("status=captured -> 200", capRes.status, 200);
      const capIds = (capRes.body?.payments || []).map((p) => p.id);
      check("captured filter includes captured ID", capIds.includes(CAPTURED_ID), true);
      check("captured filter excludes failed ID", capIds.includes(FAILED_ID), false);
      check("captured filter excludes recovered ID", capIds.includes(RECOVERED_ID), false);
      const allCap = (capRes.body?.payments || []).every((p) => p.status === "captured");
      check("all returned rows have status 'captured'", allCap, true);

      // Filter: recovered
      const recRes = await fetchPayments("status=recovered");
      check("status=recovered -> 200", recRes.status, 200);
      const recIds = (recRes.body?.payments || []).map((p) => p.id);
      check("recovered filter includes recovered ID", recIds.includes(RECOVERED_ID), true);
      check("recovered filter excludes failed ID", recIds.includes(FAILED_ID), false);
      check("recovered filter excludes captured ID", recIds.includes(CAPTURED_ID), false);
      const allRec = (recRes.body?.payments || []).every((p) => p.status === "recovered");
      check("all returned rows have status 'recovered'", allRec, true);

      // Filter: all
      const allRes = await fetchPayments("status=all");
      check("status=all -> 200", allRes.status, 200);
      const allIds = (allRes.body?.payments || []).map((p) => p.id);
      check("status=all includes failed ID", allIds.includes(FAILED_ID), true);
      check("status=all includes captured ID", allIds.includes(CAPTURED_ID), true);
      check("status=all includes recovered ID", allIds.includes(RECOVERED_ID), true);
    }

    console.log("\n--- 3. Limit Parameter ---");
    {
      const limitRes = await fetchPayments("limit=2");
      check("limit=2 -> 200", limitRes.status, 200);
      check("returns at most 2 items", limitRes.body?.payments?.length <= 2, true);
      check("count matches array length", limitRes.body?.count, limitRes.body?.payments?.length);
    }

    console.log("\n--- 4. Invalid Query Parameters (400) ---");
    {
      const invalidStatusRes = await fetchPayments("status=invalid_status_xyz");
      check("invalid status -> 400", invalidStatusRes.status, 400);
      check("invalid status success is false", invalidStatusRes.body?.success, false);

      const negativeLimitRes = await fetchPayments("limit=-1");
      check("negative limit -> 400", negativeLimitRes.status, 400);

      const zeroLimitRes = await fetchPayments("limit=0");
      check("zero limit -> 400", zeroLimitRes.status, 400);

      const excessiveLimitRes = await fetchPayments("limit=201");
      check("limit > 200 -> 400", excessiveLimitRes.status, 400);

      const nonNumericLimitRes = await fetchPayments("limit=abc");
      check("non-numeric limit -> 400", nonNumericLimitRes.status, 400);
    }

  } finally {
    console.log("\n--- Teardown & Cleanup ---");
    await Payment.deleteMany({ razorpayPaymentId: new RegExp(`^${SYNTHETIC_PREFIX}`) });

    const finalCount = await Payment.countDocuments();
    check("Payment count restored cleanly", finalCount, initialCount);

    await mongoose.disconnect();
  }

  console.log("\n" + (failures === 0 ? "PASS: All payments endpoint assertions passed successfully." : `FAIL: ${failures} assertion(s) failed.`));
  process.exit(failures === 0 ? 0 : 1);
})();

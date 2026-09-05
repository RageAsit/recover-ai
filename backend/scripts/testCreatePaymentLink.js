require("dotenv").config();
const { createPaymentLink } = require("../services/razorpayService");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  const shown = typeof actual === "object" ? JSON.stringify(actual) : actual;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${shown}`);
}

(async () => {
  const isApply = process.argv.includes("--apply");
  console.log(`=== Test createPaymentLink [${isApply ? "LIVE CALL (--apply)" : "DRY RUN (no API call)"}] ===\n`);

  // 1. Missing referenceId validation assertion (safe, runs in both modes)
  console.log("A. Missing referenceId validation");
  let missingRefThrew = false;
  try {
    await createPaymentLink({
      amount: 100,
      currency: "INR",
      // referenceId omitted
    });
  } catch (err) {
    if (err.reason === "missing_reference_id" || err.message.includes("referenceId")) {
      missingRefThrew = true;
    }
  }
  check("throws when referenceId is missing", missingRefThrew, true);
  console.log("");

  // 2. Prepare payload parameters
  const testRefId = `plink_test_${Date.now()}`;

  const dryRunPayload = {
    amount: 100,
    currency: "INR",
    reference_id: testRefId,
    description: "RecoverAI test",
    customer: {
      contact: "[redacted]",
    },
    notify: {
      sms: false,
      email: false,
    },
  };

  if (!isApply) {
    console.log("B. Dry Run Payload (what WOULD be sent):");
    console.log(JSON.stringify(dryRunPayload, null, 2));
    console.log("\n--------------------------------------------------------------------------------");
    console.log("DRY RUN MODE: No API request was sent.");
    console.log("To execute the live Razorpay API call, run:");
    console.log("  node scripts/testCreatePaymentLink.js --apply");
    console.log("--------------------------------------------------------------------------------");
    process.exit(failures === 0 ? 0 : 1);
    return;
  }

  // --- LIVE MODE (--apply) ---
  console.log("B. Live API Execution (--apply)");
  if (!process.env.TEST_CONTACT || process.env.TEST_CONTACT.trim() === "") {
    console.error("ABORT: TEST_CONTACT environment variable is absent or empty. Do not hardcode a phone number.");
    process.exit(1);
  }

  try {
    // a) Create one link
    const link = await createPaymentLink({
      amount: 100,
      currency: "INR",
      referenceId: testRefId,
      description: "RecoverAI test",
      customerContact: process.env.TEST_CONTACT.trim(),
    });

    // b) Assert the returned object has exactly the five allowlisted keys
    const returnedKeys = Object.keys(link).sort();
    check("exact 5 allowlisted keys returned", returnedKeys, [
      "amount",
      "id",
      "referenceId",
      "shortUrl",
      "status",
    ]);

    // c) Assert status is non-empty string and shortUrl starts with https://
    check("status is non-empty string", typeof link.status === "string" && link.status.length > 0, true);
    check("shortUrl starts with https://", typeof link.shortUrl === "string" && link.shortUrl.startsWith("https://"), true);
    check("amount matches input (100 paise)", link.amount, 100);
    check("referenceId matches input", link.referenceId, testRefId);

    // d) Idempotency test: call again with same referenceId and assert it fails
    console.log("\nC. Razorpay-side Idempotency Check");
    let duplicateFailed = false;
    try {
      await createPaymentLink({
        amount: 100,
        currency: "INR",
        referenceId: testRefId,
        description: "RecoverAI test duplicate",
        customerContact: process.env.TEST_CONTACT.trim(),
      });
    } catch (err) {
      duplicateFailed = true;
    }
    check("duplicate referenceId rejected by Razorpay", duplicateFailed, true);

    // e) Print link id, referenceId, and shortUrl on its own line with no customer details beside it
    console.log("\n=== CREATED PAYMENT LINK DETAILS ===");
    console.log(`Link ID:      ${link.id}`);
    console.log(`Reference ID: ${link.referenceId}`);
    console.log(`Status:       ${link.status}`);
    console.log(`Amount:       ${link.amount} paise`);
    console.log(`Short URL:\n${link.shortUrl}`);

    console.log("");
    if (failures === 0) {
      console.log("PASS: createPaymentLink verified successfully.");
      process.exit(0);
    } else {
      console.error(`FAIL: ${failures} check(s) failed.`);
      process.exit(1);
    }
  } catch (err) {
    console.error("Error during live payment link creation:", err.message);
    process.exit(1);
  }
})();

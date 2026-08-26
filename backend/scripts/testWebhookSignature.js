/**
 * Manual test for Razorpay webhook signature verification.
 *
 * Uses a LOCAL DEVELOPMENT SECRET only - never a real Razorpay webhook secret.
 * Start the server with the same secret, then run this script:
 *
 *   RAZORPAY_WEBHOOK_SECRET=whsec_local_dev_only npm run dev
 *   node scripts/testWebhookSignature.js
 *
 * Optional env: BASE_URL (default http://localhost:5000)
 */
const crypto = require("crypto");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "whsec_local_dev_only";
const URL = `${BASE_URL}/api/webhooks/razorpay`;

// Minimal Razorpay-shaped event. Since the event-parsing step landed, the
// endpoint requires a real event name, so this fixture must carry one.
// Shape only - not captured from Razorpay.
const PAYLOAD = JSON.stringify({
  entity: "event",
  event: "payment.failed",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: "pay_SIGTEST001",
        amount: 249900,
        currency: "INR",
        status: "failed",
        order_id: "order_SIGTEST001",
      },
    },
  },
});

function sign(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function post(label, { signature, body = PAYLOAD }) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["X-Razorpay-Signature"] = signature;

  const res = await fetch(URL, { method: "POST", headers, body });
  const text = await res.text();
  console.log(`${label.padEnd(34)} -> HTTP ${res.status}  ${text}`);
  return res.status;
}

(async () => {
  console.log(`Testing ${URL}\n`);

  const valid = await post("1. valid signature", { signature: sign(PAYLOAD, SECRET) });
  const wrong = await post("2. wrong signature", { signature: "a".repeat(64) });
  const none = await post("3. no signature header", {});
  const otherSecret = await post("4. signature from other secret", {
    signature: sign(PAYLOAD, "some_other_secret"),
  });
  // Signature of the original payload, but the body has been mutated
  // (amount 249900 -> 249901). One byte changes the digest completely.
  const tampered = await post("5. tampered body, valid old sig", {
    signature: sign(PAYLOAD, SECRET),
    body: PAYLOAD.replace("249900", "249901"),
  });

  console.log("");
  const pass =
    valid === 200 && wrong === 401 && none === 401 && otherSecret === 401 && tampered === 401;
  console.log(pass ? "PASS: all signature cases behaved correctly" : "FAIL: unexpected status codes");
  process.exit(pass ? 0 : 1);
})();

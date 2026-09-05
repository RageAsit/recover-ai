require("dotenv").config();

const apiKey = process.env.LLM_API_KEY;
const modelEnv = process.env.LLM_MODEL;

if (!apiKey || apiKey.trim() === "") {
  console.error("ABORT: LLM_API_KEY is missing or empty in environment");
  process.exit(1);
}

if (!modelEnv || modelEnv.trim() === "") {
  console.error("ABORT: LLM_MODEL is missing or empty in environment");
  process.exit(1);
}

const trimmedModel = modelEnv.trim();
const normalizedModel = trimmedModel.startsWith("models/")
  ? trimmedModel
  : `models/${trimmedModel}`;

const url = `https://generativelanguage.googleapis.com/v1beta/${normalizedModel}:generateContent`;

const ALLOWED_ACTIONS = Object.freeze([
  "CREATE_PAYMENT_LINK",
  "RETRY",
  "NO_ACTION",
  "STOP",
  "HUMAN_REVIEW",
]);

(async () => {
  const payload = {
    contents: [
      {
        parts: [
          {
            text: "A payment of INR 2499 failed because the customer's card was declined due to insufficient funds. This is a first-time customer attempting their initial transaction. Provide a recovery recommendation for this failure.",
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          action: {
            type: "STRING",
            enum: ALLOWED_ACTIONS,
          },
          confidence: {
            type: "NUMBER",
            description: "Confidence score between 0 and 1",
          },
          reason: {
            type: "STRING",
            description: "Explanation for the recommended action",
          },
          requiresHumanReview: {
            type: "BOOLEAN",
            description: "Flag indicating whether human review is required",
          },
        },
        required: [
          "action",
          "confidence",
          "reason",
          "requiresHumanReview",
        ],
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey.trim(),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Request failed with status ${response.status}:`);
    console.error(errorBody);
    process.exit(1);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data?.candidates?.[0]?.finishReason ?? "(none)";
  const usageMetadata = data?.usageMetadata ?? null;

  console.log("=== 1. RAW RESPONSE TEXT ===");
  console.log(rawText);
  console.log("");

  console.log("=== 2. PARSED JSON OBJECT ===");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
    console.log(JSON.stringify(parsed, null, 2));
  } catch (err) {
    console.error(`FAIL: JSON.parse threw an error: ${err.message}`);
    process.exit(1);
  }
  console.log("");

  console.log("=== 3. FIELD & TYPE VALIDATION ===");
  let validationErrors = 0;

  // action
  if (typeof parsed.action === "string" && ALLOWED_ACTIONS.includes(parsed.action)) {
    console.log(`  ok  action: "${parsed.action}" (valid enum string)`);
  } else {
    console.error(`  FAIL action: expected one of [${ALLOWED_ACTIONS.join(", ")}], got ${JSON.stringify(parsed.action)}`);
    validationErrors++;
  }

  // confidence
  if (typeof parsed.confidence === "number" && !isNaN(parsed.confidence) && parsed.confidence >= 0 && parsed.confidence <= 1) {
    console.log(`  ok  confidence: ${parsed.confidence} (number in [0, 1])`);
  } else {
    console.error(`  FAIL confidence: expected number in [0, 1], got ${JSON.stringify(parsed.confidence)}`);
    validationErrors++;
  }

  // reason
  if (typeof parsed.reason === "string" && parsed.reason.trim().length > 0) {
    console.log(`  ok  reason: "${parsed.reason}" (non-empty string)`);
  } else {
    console.error(`  FAIL reason: expected non-empty string, got ${JSON.stringify(parsed.reason)}`);
    validationErrors++;
  }

  // requiresHumanReview
  if (typeof parsed.requiresHumanReview === "boolean") {
    console.log(`  ok  requiresHumanReview: ${parsed.requiresHumanReview} (boolean)`);
  } else {
    console.error(`  FAIL requiresHumanReview: expected boolean, got ${JSON.stringify(parsed.requiresHumanReview)}`);
    validationErrors++;
  }
  console.log("");

  console.log("=== 4. METADATA ===");
  console.log(`finishReason: ${finishReason}`);
  console.log("usageMetadata:", JSON.stringify(usageMetadata, null, 2));
  console.log("");

  if (validationErrors > 0) {
    console.error(`Validation failed with ${validationErrors} error(s).`);
    process.exit(1);
  }

  console.log("PASS: Structured JSON schema response verified successfully.");
})();

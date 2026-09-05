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

(async () => {
  const payload = {
    contents: [
      {
        parts: [
          {
            text: "Reply with exactly the word OK and nothing else.",
          },
        ],
      },
    ],
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
  const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "(none)";

  console.log("=== 1. EXTRACTED REPLY TEXT ===");
  console.log(replyText);
  console.log("");

  console.log("=== 2. USAGE METADATA ===");
  if (data.usageMetadata) {
    console.log(JSON.stringify(data.usageMetadata, null, 2));
  } else {
    console.log("(no usageMetadata in response)");
  }
  console.log("");

  console.log("=== 3. FULL RESPONSE JSON ===");
  console.log(JSON.stringify(data, null, 2));
})();

const ALLOWED_ACTIONS = Object.freeze([
  "CREATE_PAYMENT_LINK",
  "RETRY",
  "NO_ACTION",
  "STOP",
  "HUMAN_REVIEW",
]);

/**
 * Fail-closed fallback recommendation.
 *
 * FAIL-CLOSED SAFETY PRINCIPLE:
 * On ANY failure (missing config, network error, non-2xx status, unparseable JSON,
 * or validation failure), we must fail closed to HUMAN_REVIEW with confidence 0
 * and requiresHumanReview true. We must NEVER fail open into an automated action
 * (e.g. RETRY or CREATE_PAYMENT_LINK) that could move money or contact customers unexpectedly.
 *
 * @param {string} failureReason
 * @returns {{
 *   action: "HUMAN_REVIEW",
 *   confidence: 0,
 *   reason: string,
 *   requiresHumanReview: true,
 *   modelVersion: null,
 *   responseId: null
 * }}
 */
function failClosed(failureReason) {
  return {
    action: "HUMAN_REVIEW",
    confidence: 0,
    reason: `LLM decision failed closed: ${failureReason}`,
    requiresHumanReview: true,
    modelVersion: null,
    responseId: null,
  };
}

/**
 * Solicits a recovery recommendation from LLM or returns a mock object when LLM_MOCK is true.
 *
 * CRITICAL PRIVACY & SECURITY RULES:
 * - Context must never contain PII (only non-identifying metadata & boolean flags).
 * - LLM_API_KEY must never be logged, printed, or interpolated in error messages.
 *
 * @param {{
 *   context: Object,
 *   recoveryHistory: Object
 * }} params
 * @returns {Promise<{
 *   action: "CREATE_PAYMENT_LINK" | "RETRY" | "NO_ACTION" | "STOP" | "HUMAN_REVIEW",
 *   confidence: number,
 *   reason: string,
 *   requiresHumanReview: boolean,
 *   modelVersion: string | null,
 *   responseId: string | null
 * }>}
 */
async function getRecoveryRecommendation({ context, recoveryHistory }) {
  // 1. MOCK MODE (development / zero quota consumption)
  // Accept "true", "1", "yes" case-insensitively and trimmed.
  // The failure mode being guarded against is silently falling through to a real
  // API call and exhausting the limited daily request quota during development/testing.
  const rawMock = typeof process.env.LLM_MOCK === "string" ? process.env.LLM_MOCK.trim().toLowerCase() : "";
  const isMock = ["true", "1", "yes"].includes(rawMock);

  if (isMock) {
    return {
      action: "CREATE_PAYMENT_LINK",
      confidence: 0.75,
      requiresHumanReview: false,
      modelVersion: "mock",
      responseId: `mock-${Date.now()}`,
      reason: "MOCK: Automated payment link recommended for recoverable card failure.",
    };
  }

  // 2. REAL LLM PATH (Gemini REST API)
  const apiKey = process.env.LLM_API_KEY;
  const modelEnv = process.env.LLM_MODEL;

  if (!apiKey || apiKey.trim() === "") {
    return failClosed("LLM_API_KEY is missing or empty in environment");
  }

  if (!modelEnv || modelEnv.trim() === "") {
    return failClosed("LLM_MODEL is missing or empty in environment");
  }

  const trimmedModel = modelEnv.trim();
  const normalizedModel = trimmedModel.startsWith("models/")
    ? trimmedModel
    : `models/${trimmedModel}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/${normalizedModel}:generateContent`;

  const promptText = `You are a payment recovery analyst. Based on the following failed payment context and recovery attempt history, provide a recovery recommendation according to the schema.

Payment Context:
${JSON.stringify(context, null, 2)}

Recovery History:
${JSON.stringify(recoveryHistory, null, 2)}

Provide your analysis and recommendation in structured JSON format.`;

  const payload = {
    contents: [
      {
        parts: [{ text: promptText }],
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

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey.trim(),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
  } catch (netErr) {
    if (netErr.name === "TimeoutError" || netErr.name === "AbortError") {
      return failClosed("Request timed out after 30 seconds contacting LLM provider");
    }
    return failClosed(`Network error contacting LLM provider (${netErr.message})`);
  }

  if (!response.ok) {
    let errorSummary = `HTTP status ${response.status}`;
    try {
      const errText = await response.text();
      const parsedErr = JSON.parse(errText);
      if (parsedErr?.error?.message) {
        errorSummary += ` - ${parsedErr.error.message}`;
      }
    } catch {
      // Keep errorSummary as status code
    }
    return failClosed(`LLM provider error: ${errorSummary}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (jsonErr) {
    return failClosed(`Failed to parse LLM provider response JSON (${jsonErr.message})`);
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText || typeof rawText !== "string") {
    return failClosed("No text content returned in LLM candidate parts");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    return failClosed(`Failed to parse candidate structured JSON (${parseErr.message})`);
  }

  // Validate parsed fields
  if (!parsed || typeof parsed !== "object") {
    return failClosed("Parsed candidate is not an object");
  }

  if (!ALLOWED_ACTIONS.includes(parsed.action)) {
    return failClosed(`Invalid action received: ${JSON.stringify(parsed.action)}`);
  }

  if (
    typeof parsed.confidence !== "number" ||
    isNaN(parsed.confidence) ||
    parsed.confidence < 0 ||
    parsed.confidence > 1
  ) {
    return failClosed(`Invalid confidence received: ${JSON.stringify(parsed.confidence)}`);
  }

  if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
    return failClosed("Missing or empty reason received from LLM");
  }

  if (typeof parsed.requiresHumanReview !== "boolean") {
    return failClosed(`Invalid requiresHumanReview received: ${JSON.stringify(parsed.requiresHumanReview)}`);
  }

  // If the upstream API response omits modelVersion, record null rather than guessing
  // or falling back to the requested model string, so the audit trail never records false claims.
  const modelVersion = data?.modelVersion ?? null;
  const responseId = data?.responseId ?? null;

  return {
    action: parsed.action,
    confidence: parsed.confidence,
    reason: parsed.reason,
    requiresHumanReview: parsed.requiresHumanReview,
    modelVersion,
    responseId,
  };
}

module.exports = {
  ALLOWED_ACTIONS,
  getRecoveryRecommendation,
};

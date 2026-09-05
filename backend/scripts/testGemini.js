require("dotenv").config();

const apiKey = process.env.LLM_API_KEY;

if (!apiKey || apiKey.trim() === "") {
  console.error("ABORT: LLM_API_KEY is missing or empty in environment");
  process.exit(1);
}

const LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

(async () => {
  const response = await fetch(LIST_MODELS_URL, {
    method: "GET",
    headers: {
      "x-goog-api-key": apiKey.trim(),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Request failed with status ${response.status}:`);
    console.error(errorBody);
    process.exit(1);
  }

  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models : [];

  for (const model of models) {
    if (
      Array.isArray(model.supportedGenerationMethods) &&
      model.supportedGenerationMethods.includes("generateContent")
    ) {
      console.log(model.name);
    }
  }
})();

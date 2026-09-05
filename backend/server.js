require("dotenv").config();

const express = require("express");
const cors = require("cors");

const mongoose = require("mongoose");
const { connectDB } = require("./config/db");
const razorpayService = require("./services/razorpayService");
const { isWebhookSecretConfigured } = require("./services/webhookSignature");
const paymentRoutes = require("./routes/paymentRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const recoveryRoutes = require("./routes/recoveryRoutes");
const demoRoutes = require("./routes/demoRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

const allowedLocalOriginRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const configuredFrontendOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(",").map((o) => o.trim())
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, server-to-server, test scripts)
    if (!origin) {
      return callback(null, true);
    }
    // Allow configured production frontend origins
    if (configuredFrontendOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Allow local development origins
    if (allowedLocalOriginRegex.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

// ORDER IS LOAD-BEARING: webhooks mount BEFORE express.json().
// express.json() would consume the request stream and hand the route a parsed
// object, leaving express.raw() with nothing. Mounting first means the webhook
// keeps its raw Buffer, while every route below still gets normal JSON.
app.use("/api/webhooks", webhookRoutes);

app.use(express.json());

// Malformed JSON body -> JSON error instead of Express's default HTML page.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      success: false,
      message: "Request body must be valid JSON",
    });
  }
  return next(err);
});

app.use("/api/payments", paymentRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/recovery", recoveryRoutes);
app.use("/api/demo", demoRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "RecoverAI backend is running",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// Read-only check that our Razorpay Test Mode credentials authenticate.
app.get("/api/test/razorpay", async (req, res) => {
  try {
    await razorpayService.verifyConnection();
    res.json({
      success: true,
      message: "Razorpay Test Mode connection successful",
    });
  } catch (err) {
    const safe = razorpayService.describeError(err);
    console.error(`[razorpay] connection check failed: ${safe.reason} - ${safe.detail}`);
    res.status(safe.status).json({
      success: false,
      message: "Razorpay Test Mode connection failed",
      reason: safe.reason,
      detail: safe.detail,
    });
  }
});

connectDB();

app.listen(PORT, () => {
  console.log(`RecoverAI backend listening on http://localhost:${PORT}`);

  const missing = razorpayService.getMissingCredentials();
  if (missing.length > 0) {
    console.warn(
      `[razorpay] Warning: ${missing.join(", ")} not set in .env - ` +
        `GET /api/test/razorpay will report a failure until configured.`
    );
  }

  if (!isWebhookSecretConfigured()) {
    console.warn(
      "[webhook] Warning: RAZORPAY_WEBHOOK_SECRET not set in .env - " +
        "POST /api/webhooks/razorpay will reject every request until configured."
    );
  }
});

/**
 * GET /api/health
 *
 * Liveness check. No external calls, no secrets - just proof that the process
 * is up and answering requests.
 */

const express = require('express');
const { config, hasRazorpayCredentials } = require('../config/env');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'recoverai-backend',
    status: 'ok',
    environment: config.nodeEnv,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    // Boolean only - tells you whether keys are loaded, never what they are.
    razorpayConfigured: hasRazorpayCredentials(),
  });
});

module.exports = router;

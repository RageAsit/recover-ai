/**
 * API router. Every new feature area gets one `router.use()` line here.
 */

const express = require('express');

const { config } = require('../config/env');
const healthRoutes = require('./health.routes');
const testRoutes = require('./test.routes');

const router = express.Router();

router.use('/health', healthRoutes);

// Diagnostics are a development convenience and stay out of production.
if (!config.isProduction) {
  router.use('/test', testRoutes);
}

module.exports = router;

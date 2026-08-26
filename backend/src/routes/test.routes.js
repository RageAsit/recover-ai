/**
 * Development-only diagnostics.
 *
 * These routes are mounted by src/routes/index.js only when NODE_ENV is not
 * "production", so they cannot be reached from a deployed instance.
 */

const express = require('express');
const razorpayService = require('../services/razorpay.service');

const router = express.Router();

/**
 * GET /api/test/razorpay
 *
 * Makes one safe, read-only request to Razorpay Test Mode and reports whether
 * authentication worked. The response is assembled by hand so that no
 * credential, header or raw SDK error can leak into it.
 */
router.get('/razorpay', async (req, res, next) => {
  try {
    const result = await razorpayService.checkConnection();

    res.json({
      success: true,
      message: 'Razorpay Test Mode connection verified.',
      razorpay: result,
    });
  } catch (error) {
    // Handing off to the central error handler keeps sanitisation in one place.
    next(error);
  }
});

module.exports = router;

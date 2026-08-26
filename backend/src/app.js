/**
 * Express application setup.
 *
 * Kept separate from server.js so the app can be imported (by tests or a
 * different runtime) without immediately binding a port.
 */

const express = require('express');
const cors = require('cors');

const { config } = require('./config/env');
const apiRoutes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Allow the (future) Vite frontend to call this API from its own origin.
app.use(cors({ origin: config.corsOrigins }));

// Parse JSON request bodies.
app.use(express.json());

// Minimal request log - handy during development, no request bodies or headers.
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Friendly root response so hitting the base URL is not a 404.
app.get('/', (req, res) => {
  res.json({
    success: true,
    service: 'RecoverAI backend',
    endpoints: ['/api/health', '/api/test/razorpay (development only)'],
  });
});

app.use('/api', apiRoutes);

// These two must stay last, in this order.
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

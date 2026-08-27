const mongoose = require("mongoose");
const { getRecoveryQueue } = require("../services/recoveryQueue");

async function getRecovery(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[recovery] MongoDB not connected - cannot fetch queue");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    const queue = await getRecoveryQueue();
    return res.status(200).json(queue);
  } catch (err) {
    console.error(`[recovery] Failed to fetch queue: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch queue",
    });
  }
}

module.exports = { getRecovery };

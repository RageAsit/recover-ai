const mongoose = require("mongoose");
const { getDashboardStats } = require("../services/dashboardStats");

async function getDashboard(req, res) {
  if (mongoose.connection.readyState !== 1) {
    console.error("[dashboard] MongoDB not connected - cannot fetch stats");
    return res.status(503).json({
      success: false,
      message: "Database unavailable",
    });
  }

  try {
    const stats = await getDashboardStats();
    return res.status(200).json(stats);
  } catch (err) {
    console.error(`[dashboard] Failed to fetch stats: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stats",
    });
  }
}

module.exports = { getDashboard };

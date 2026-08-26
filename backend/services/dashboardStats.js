const Payment = require("../models/Payment");

/**
 * Computes the dashboard metrics from the payments collection.
 * 
 * Returns exactly three keys, all amounts in paise:
 * { revenueAtRisk, revenueRecovered, recoveryRate }
 */
async function getDashboardStats() {
  const stats = await Payment.aggregate([
    {
      $match: {
        status: { $in: ["failed", "recovered"] },
      },
    },
    {
      $group: {
        _id: "$status",
        total: { $sum: "$amount" },
      },
    },
  ]);

  let revenueAtRisk = 0;
  let revenueRecovered = 0;

  for (const stat of stats) {
    if (stat._id === "failed") {
      revenueAtRisk = stat.total;
    } else if (stat._id === "recovered") {
      revenueRecovered = stat.total;
    }
  }

  const denominator = revenueRecovered + revenueAtRisk;
  let recoveryRate = 0;

  if (denominator > 0) {
    // The denominator is (recovered + failed), NOT just revenueAtRisk.
    // A recovered payment is no longer at risk (its status changed from failed to recovered),
    // so dividing by the outstanding figure alone (revenueAtRisk) would exclude it from the base
    // and could result in a percentage exceeding 100%.
    const rate = (revenueRecovered / denominator) * 100;
    recoveryRate = Math.round(rate * 10) / 10;
  }

  return {
    revenueAtRisk,
    revenueRecovered,
    recoveryRate,
  };
}

module.exports = { getDashboardStats };

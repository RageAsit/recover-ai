const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    razorpayPaymentId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpayOrderId: String,
    amount: {
      type: Number,
      required: true,
    },
    currency: String,
    status: {
      type: String,
      enum: ["failed", "captured", "recovered"],
    },
    method: String,
    failureReason: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);

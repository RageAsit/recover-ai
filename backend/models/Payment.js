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
    customerEmail: {
      type: String,
      index: true,
    },
    customerContact: String,
    isDemo: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);

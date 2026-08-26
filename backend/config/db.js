const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  
  if (!uri) {
    console.warn(
      "[database] Warning: MONGODB_URI not set in .env - " +
        "MongoDB connection skipped."
    );
    return;
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[database] Connected to MongoDB database: ${mongoose.connection.name}`);
  } catch (err) {
    console.error("[database] Connection failed:", err.message);
  }
}

module.exports = { connectDB };

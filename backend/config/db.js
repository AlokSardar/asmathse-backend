const mongoose = require('mongoose');

let isConnecting = false;

const connectDB = async () => {
  if (isConnecting) return;
  isConnecting = true;

  const tryConnect = async () => {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
      isConnecting = false;
      return conn;
    } catch (error) {
      console.warn(`⚠️ MongoDB Atlas Connection Notice: ${error.message}`);
      console.warn(`👉 Make sure your IP is whitelisted on MongoDB Atlas (Network Access -> 0.0.0.0/0 or Current IP).`);
      console.log(`🔄 Re-attempting MongoDB connection in 8 seconds...`);
      setTimeout(tryConnect, 8000);
    }
  };

  return tryConnect();
};

module.exports = connectDB;

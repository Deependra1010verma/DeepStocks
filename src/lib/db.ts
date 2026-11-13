import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/deepstocks";

declare global {
  var _mongooseConn: typeof mongoose | null;
}

export async function connectDB() {
  if (global._mongooseConn && mongoose.connection.readyState === 1) {
    return global._mongooseConn;
  }
  global._mongooseConn = await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  return global._mongooseConn;
}

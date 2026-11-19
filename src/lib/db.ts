import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/deepstocks";

declare global {
  var _mongooseConn: typeof mongoose | null;
  var _mongooseConnectPromise: Promise<typeof mongoose> | null;
}

export async function connectDB() {
  if (!process.env.MONGODB_URI && process.env.NODE_ENV === "production") {
    throw new Error("MONGODB_URI is required in the deployed environment");
  }
  if (global._mongooseConn && mongoose.connection.readyState === 1) {
    return global._mongooseConn;
  }
  if (global._mongooseConnectPromise) return global._mongooseConnectPromise;

  global._mongooseConnectPromise = mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
    socketTimeoutMS: 5000,
    maxPoolSize: 5,
    waitQueueTimeoutMS: 3000,
    // Candles dominate snapshot/cache payloads; negotiate built-in compression.
    compressors: ['zlib'],
    zlibCompressionLevel: 6,
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
  }).then((connection) => {
    global._mongooseConn = connection;
    return connection;
  }).finally(() => {
    global._mongooseConnectPromise = null;
  });

  return global._mongooseConnectPromise;
}

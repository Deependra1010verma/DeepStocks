import mongoose, { Schema, Document } from "mongoose";

export interface IStockCache extends Document {
  symbol: string;
  date: string;
  candles: object[];
  historyVersion?: number;
  fundamentals: object;
  updatedAt: Date;
}

const StockCacheSchema = new Schema<IStockCache>({
  symbol: { type: String, required: true, index: true },
  date: { type: String, required: true },
  candles: [Schema.Types.Mixed],
  historyVersion: Number,
  fundamentals: Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now },
});

StockCacheSchema.index({ symbol: 1, date: 1 }, { unique: true });

export const StockCache =
  mongoose.models.StockCache ||
  mongoose.model<IStockCache>("StockCache", StockCacheSchema);

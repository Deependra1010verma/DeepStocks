import mongoose, { Document, Schema } from "mongoose";

export interface IWatchlist extends Document {
  userId: string;
  symbol: string;
  mode?: string;
  note?: string;
  alertEnabled: boolean;
  zoneLow?: number;
  zoneHigh?: number;
  createdAt: Date;
}

const WatchlistSchema = new Schema<IWatchlist>({
  userId: { type: String, required: true, index: true },
  symbol: { type: String, required: true },
  mode: { type: String },
  note: { type: String, default: "" },
  alertEnabled: { type: Boolean, default: true },
  zoneLow: { type: Number },
  zoneHigh: { type: Number },
  createdAt: { type: Date, default: Date.now },
});

WatchlistSchema.index({ userId: 1, symbol: 1 }, { unique: true });

export const Watchlist = mongoose.models.Watchlist || mongoose.model<IWatchlist>("Watchlist", WatchlistSchema);

import mongoose, { Document, Schema } from "mongoose";
import type { ScreenerMode, ScreenedStock } from "@/lib/screenerEngine";
import type { ScanCoverage, ScanProgress } from '../scanProgress';

export interface RemovedScanStock {
  symbol: string;
  name: string;
  sector: string;
  quantScore: number;
  reason: string;
  removedAt: Date;
  lastSeenAt: Date;
}

export interface IScanSnapshot extends Document {
  version?: string;
  coverage?: ScanCoverage;
  progress?: ScanProgress;
  status?: 'ready' | 'partial' | 'unavailable';
  message?: string;
  mode: ScreenerMode;
  sector: string;
  stocks: ScreenedStock[];
  removedToday: RemovedScanStock[];
  generatedAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

const RemovedScanStockSchema = new Schema<RemovedScanStock>({
  symbol: { type: String, required: true },
  name: { type: String, required: true },
  sector: { type: String, default: "Unknown" },
  quantScore: { type: Number, default: 0 },
  reason: { type: String, required: true },
  removedAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
}, { _id: false });

const ScanSnapshotSchema = new Schema<IScanSnapshot>({
  version: String,
  coverage: Schema.Types.Mixed,
  progress: Schema.Types.Mixed,
  status: String,
  message: String,
  mode: { type: String, required: true, index: true },
  sector: { type: String, required: true, default: "All", index: true },
  stocks: { type: Schema.Types.Mixed, default: [] },
  removedToday: { type: [RemovedScanStockSchema], default: [] },
  generatedAt: { type: Date, required: true, default: Date.now },
  expiresAt: { type: Date, required: true, index: true },
  updatedAt: { type: Date, default: Date.now },
});

ScanSnapshotSchema.index({ mode: 1, sector: 1 }, { unique: true });

export const ScanSnapshot =
  mongoose.models.ScanSnapshot || mongoose.model<IScanSnapshot>("ScanSnapshot", ScanSnapshotSchema);

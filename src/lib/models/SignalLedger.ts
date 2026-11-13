import mongoose, { Document, Schema } from "mongoose";

export type SignalStatus = "OPEN" | "TARGET1" | "TARGET2" | "STOP_LOSS" | "EXPIRED";

export interface ISignalLedger extends Document {
  symbol: string;
  mode: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  quantScore: number;
  status: SignalStatus;
  signalDate: string;
  updatedAt: Date;
}

const SignalLedgerSchema = new Schema<ISignalLedger>({
  symbol: { type: String, required: true, index: true },
  mode: { type: String, required: true },
  entry: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  target1: { type: Number, required: true },
  target2: { type: Number, required: true },
  quantScore: { type: Number, required: true },
  status: { type: String, enum: ["OPEN", "TARGET1", "TARGET2", "STOP_LOSS", "EXPIRED"], default: "OPEN" },
  signalDate: { type: String, required: true, index: true },
  updatedAt: { type: Date, default: Date.now },
});

SignalLedgerSchema.index({ symbol: 1, mode: 1, signalDate: 1 }, { unique: true });

export const SignalLedger = mongoose.models.SignalLedger || mongoose.model<ISignalLedger>("SignalLedger", SignalLedgerSchema);

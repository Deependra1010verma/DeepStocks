import mongoose, { Document, Schema } from "mongoose";

export type SignalStatus = 'PENDING' | 'OPEN' | 'TARGET1' | 'TARGET2' | 'STOP_LOSS' | 'EXPIRED' | 'AMBIGUOUS' | 'UNRESOLVED';

export interface ISignalLedger extends Document {
  evaluationVersion?: number;
  strategyVersion?: string;
  decisionAt?: Date;
  quoteAt?: Date;
  casEligibleAtSignal?: boolean;
  entryLow: number;
  entryHigh: number;
  createdAt: Date;
  entryExpiresAt: Date;
  expiresAt: Date;
  filledAt?: Date;
  closedAt?: Date;
  checkedThrough?: Date;
  target1At?: Date;
  target1Price?: number;
  realizedR?: number;
  exitPrice?: number;
  outcomeReason?: string;
  costBps?: number;
  slippageBps?: number;
  symbol: string;
  mode: string;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  quantScore: number;
  rvolAtEntry?: number;
  rsiAtEntry?: number;
  sector?: string;
  regime?: string;
  riskPercent?: number;
  status: SignalStatus;
  signalDate: string;
  updatedAt: Date;
}

const SignalLedgerSchema = new Schema<ISignalLedger>({
  evaluationVersion: Number,
  strategyVersion: String, decisionAt: Date, quoteAt: Date,
  casEligibleAtSignal: Boolean,
  entryLow: Number, entryHigh: Number, createdAt: Date, entryExpiresAt: Date, expiresAt: Date,
  filledAt: Date, closedAt: Date, checkedThrough: Date, target1At: Date, target1Price: Number, realizedR: Number,
  exitPrice: Number, outcomeReason: String, costBps: Number, slippageBps: Number,
  symbol: { type: String, required: true, index: true },
  mode: { type: String, required: true },
  entry: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  target1: { type: Number, required: true },
  target2: { type: Number, required: true },
  quantScore: { type: Number, required: true },
  rvolAtEntry: { type: Number },
  rsiAtEntry: { type: Number },
  sector: { type: String, index: true },
  regime: { type: String },
  riskPercent: { type: Number },
  status: { type: String, enum: ['PENDING','OPEN','TARGET1','TARGET2','STOP_LOSS','EXPIRED','AMBIGUOUS','UNRESOLVED'], default: 'PENDING' },
  signalDate: { type: String, required: true, index: true },
  updatedAt: { type: Date, default: Date.now },
});

SignalLedgerSchema.index({ symbol: 1, mode: 1, signalDate: 1 }, { unique: true });

export const SignalLedger = mongoose.models.SignalLedger || mongoose.model<ISignalLedger>("SignalLedger", SignalLedgerSchema);

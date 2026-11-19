import mongoose, { Document, Schema } from "mongoose";
import type { AIAnalysisResult } from "@/lib/aiAnalyst";
import type { NewsItem } from "@/lib/dataFetcher";

export interface IAIAnalysisCache extends Document {
  version: string;
  fingerprint: string;
  provider: string;
  modelId: string;
  symbol: string;
  mode: string;
  marketRegime: string;
  analysis: AIAnalysisResult;
  news: NewsItem[];
  cachedCmp: number;
  generatedAt: Date;
  expiresAt: Date;
  updatedAt: Date;
}

const AIAnalysisCacheSchema = new Schema<IAIAnalysisCache>({
  version: { type: String, required: true },
  fingerprint: { type: String, required: true },
  provider: { type: String, required: true },
  modelId: { type: String, required: true },
  symbol: { type: String, required: true, index: true },
  mode: { type: String, required: true, index: true },
  marketRegime: { type: String, required: true },
  analysis: { type: Schema.Types.Mixed, required: true },
  news: { type: Schema.Types.Mixed, default: [] },
  cachedCmp: { type: Number, required: true },
  generatedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  updatedAt: { type: Date, default: Date.now },
});

AIAnalysisCacheSchema.index({ symbol: 1, mode: 1, marketRegime: 1 }, { unique: true });
AIAnalysisCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AIAnalysisCache =
  mongoose.models.AIAnalysisCache || mongoose.model<IAIAnalysisCache>("AIAnalysisCache", AIAnalysisCacheSchema);

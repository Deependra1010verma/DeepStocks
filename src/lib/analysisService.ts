import { createHash } from 'node:crypto';
import { analyzeStock, enforceRiskGuards } from './aiAnalyst';
import { fetchNews } from './dataFetcher';
import { connectDB } from './db';
import { AIAnalysisCache } from './models/AIAnalysisCache';
import { ANALYSIS_VERSION, getAIExpiry, guardFingerprint, priceMovedBeyondCache } from './aiCachePolicy';
import { providerConfig } from './aiProvider';
import { AppError, withLease } from './operations';
import { dateToISTString } from './timezone';
import type { ScreenedStock } from './screenerEngine';
export interface AnalysisPayload {
  analysis: Awaited<ReturnType<typeof analyzeStock>>; stock: ScreenedStock;
  news: Awaited<ReturnType<typeof fetchNews>>; cached: boolean; cachedAt: string;
  expiresAt: string; cachedCmp: number; fingerprint: string; provider: string; model: string;
}
const inFlight = new Map<string, Promise<AnalysisPayload>>();
export function cachedAnalysisValid(cached: { version?: string; fingerprint?: string; provider?: string; modelId?: string; expiresAt: Date|string; generatedAt: Date|string; cachedCmp: number }, stock: ScreenedStock, now = Date.now()): boolean {
  const config = providerConfig();
  return cached.version === ANALYSIS_VERSION && cached.provider === config.provider && cached.modelId === config.model && cached.fingerprint === guardFingerprint(stock) && new Date(cached.expiresAt).getTime() > now && new Date(cached.generatedAt).getTime() <= now && !stock.dataQuality?.stale && !priceMovedBeyondCache(stock.mode,cached.cachedCmp,stock.cmp);
}
export async function generateAndCache(stock: ScreenedStock, forceRefresh = false): Promise<AnalysisPayload> {
  if (!stock.dataQuality || stock.dataQuality.stale) throw new AppError('STALE_DATA','AI analysis paused because source data is stale or unverified.',422);
  const config = providerConfig(), regime = stock.regime ?? 'NEUTRAL';
  const slot = `${stock.symbol}:${stock.mode}:${regime}`;
  const revision = createHash('sha256').update(JSON.stringify(stock)).digest('hex');
  const key = `${slot}:${config.version}:${forceRefresh}:${revision}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const work = (async()=>{
    await connectDB();
    const query = {symbol:stock.symbol,mode:stock.mode,marketRegime:regime};
    const readCache = async (): Promise<AnalysisPayload | null> => {
      if (forceRefresh) return null;
      const cached = await AIAnalysisCache.findOne(query).lean();
      if (!cached || !cachedAnalysisValid(cached, stock)) return null;
      return {
        analysis: enforceRiskGuards(cached.analysis, stock), stock, news: cached.news ?? [],
        cached: true, cachedAt: new Date(cached.generatedAt).toISOString(),
        expiresAt: new Date(cached.expiresAt).toISOString(), cachedCmp: cached.cachedCmp,
        fingerprint: cached.fingerprint, provider: config.provider, model: config.model
      };
    };
    const cached = await readCache();
    if (cached) return cached;
    return withLease(`analysis:${slot}`,async()=>{
      const savedByAnotherWorker = await readCache();
      if (savedByAnotherWorker) return savedByAnotherWorker;
      const news = await fetchNews(stock.symbol);
      const analysis = await analyzeStock(stock,news,regime), now = new Date();
      const eligibility = stock.dataQuality?.sessionEligibility;
      const expires = getAIExpiry(stock.mode, now, eligibility?.day === dateToISTString(now) ? eligibility.casEligible : null);
      const fingerprint = guardFingerprint(stock);
      await AIAnalysisCache.updateOne(query,{$set:{...query,analysis,news,generatedAt:now,expiresAt:expires,cachedCmp:stock.cmp,updatedAt:now,version:ANALYSIS_VERSION,fingerprint,provider:config.provider,modelId:config.model}},{upsert:true,runValidators:true});
      return {analysis,stock,news,cached:false,cachedAt:now.toISOString(),expiresAt:expires.toISOString(),cachedCmp:stock.cmp,fingerprint,provider:config.provider,model:config.model};
    });
  })().finally(()=>inFlight.delete(key));
  inFlight.set(key,work);return work;
}

import { getMarketSession, nextMarketOpen, dateToISTString, cashSessionLimits } from './timezone';
import type { ScreenerMode, ScreenedStock } from './screenerEngine';
export const ANALYSIS_VERSION = '2026-11-evidence-v9';
export function getAIExpiry(mode: ScreenerMode, now = new Date()): Date {
  if (!getMarketSession(now).calendarVerified) return new Date(now.getTime());
  if (getMarketSession(now).state !== 'LIVE') return nextMarketOpen(now);
  const duration =
    mode === 'intraday'
      ? 900000
      : ['btst', 'swing_breakout', 'swing_pullback'].includes(mode)
        ? 3600000
        : 14400000;
  const day = dateToISTString(now),
    close = new Date(`${day}T00:00:00+05:30`).getTime() + cashSessionLimits(day).continuousEnd * 60000;
  return new Date(
    Math.min(
      mode === 'intraday'
        ? (Math.floor(now.getTime() / duration) + 1) * duration
        : now.getTime() + duration,
      close
    )
  );
}
export function priceMovedBeyondCache(
  mode: ScreenerMode,
  cachedCmp: number | null | undefined,
  cmp: number
): boolean {
  return (
    !cachedCmp ||
    cachedCmp <= 0 ||
    !Number.isFinite(cmp) ||
    cmp <= 0 ||
    Math.abs(cmp - cachedCmp) / cachedCmp > (mode === 'intraday' ? 0.005 : 0.015)
  );
}
export function guardFingerprint(stock: ScreenedStock): string {
  return JSON.stringify([
    ANALYSIS_VERSION,
    stock.mode,
    stock.nearMiss,
    stock.researchQualified,
    stock.earningsDate,
    stock.earningsRisk,
    stock.eventStatus,
    stock.exchangeEvents,
    stock.eventConflict,
    stock.surveillance,
    stock.exchangePriceBand,
    stock.sectorBenchmark,
    stock.liquidityPass,
    stock.circuitLockedRecent,
    stock.extensionWarning,
    stock.weeklyTrend,
    stock.defensiveMode,
    stock.positionRiskPercent,
    stock.dataQuality?.stale,
    stock.dataQuality?.candleAt,
    stock.dataQuality?.candleSource,
    stock.dataQuality?.restoredCashSessions,
    stock.dataQuality?.quoteSource,
    stock.relativeVolume?.kind,
    stock.tickSize,
    stock.tickSizeAsOf,
    stock.casEligible,
    stock.breakoutDaysAgo,
    stock.breakoutLevel,
    stock.entryConfirmationAt,
    stock.estimatedCostBps,
    stock.estimatedSlippageBps,
    stock.guardReasons,
    stock.fundamentals
  ]);
}

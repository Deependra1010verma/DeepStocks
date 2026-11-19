import { getMarketSession, nextMarketOpen, dateToISTString, cashSessionLimits, sessionTime } from './timezone';
import type { ScreenerMode, ScreenedStock } from './screenerEngine';
export const ANALYSIS_VERSION = '2026-11-evidence-v13';
export function getAIExpiry(mode: ScreenerMode, now = new Date(), casEligible: boolean | null = null): Date {
  const session = getMarketSession(now, casEligible);
  if (!session.calendarVerified || session.state === 'UNKNOWN') return new Date(now.getTime());
  if (session.state !== 'LIVE') return nextMarketOpen(now);
  const duration =
    mode === 'intraday'
      ? 900000
      : ['btst', 'swing_breakout', 'swing_pullback'].includes(mode)
        ? 3600000
        : 14400000;
  const day = dateToISTString(now), limits = cashSessionLimits(day, casEligible),
    close = +sessionTime(day, limits.continuousEnd), open = +sessionTime(day, limits.continuousStart);
  return new Date(
    Math.min(
      mode === 'intraday'
        ? open + (Math.floor((now.getTime() - open) / duration) + 1) * duration
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
    stock.referenceCoverage?.earnings?.status,
    stock.referenceCoverage?.actions?.status,
    stock.referenceCoverage?.asm?.status,
    stock.referenceCoverage?.gsm?.status,
    stock.eventConflict,
    stock.surveillance,
    stock.exchangePriceBand,
    stock.sectorBenchmark,
    stock.liquidityPass,
    stock.circuitLockedRecent,
    stock.extensionWarning,
    stock.weeklyTrend,
    stock.defensiveMode,
    stock.regime,
    stock.positionRiskPercent,
    stock.dataQuality?.stale,
    stock.dataQuality?.delayMinutes,
    stock.dataQuality?.sessionEligibility,
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

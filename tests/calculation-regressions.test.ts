import { afterEach, expect, it, vi } from 'vitest';
import { computeQuantScore, findBreakoutDaysAgo, screenSwingBreakout } from '../src/lib/screenerEngine';
import { computeRVOL } from '../src/lib/relativeVolume';
import { assessDataQuality } from '../src/lib/dataQuality';
import { evaluatePaperSignal, PAPER_EVALUATION_VERSION, summarizePaperSignals, type PaperSignal } from '../src/lib/ledgerEngine';
import { stock, bar, NOW } from './fixtures';
import type { StockData } from '../src/lib/dataFetcher';
afterEach(() => vi.useRealTimers());

it('does not rename a short-period EMA as EMA200', () => {
  const s = stock(), candles = s.candles.slice(-60);
  const data = { ...s, currentPrice: s.cmp, candles, weeklyCandles: s.candles } as unknown as StockData;
  const result = screenSwingBreakout(new Map([[s.symbol, data]]))[0];
  expect(result.ema200).toBeNull(); expect(result.nearMiss).toBe(true);
});
it('requires a close strictly above prior resistance for a confirmed breakout', () => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  const candles = Array.from({ length: 21 }, (_, i) => ({ ...bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString(), 99, 100), high: 100, low: 95 }));
  candles.at(-1)!.close = 99.6; candles.at(-1)!.volume = 200;
  expect(findBreakoutDaysAgo(candles)).toBeNull();
  candles.at(-1)!.close = 101; candles.at(-1)!.high = 101;
  expect(findBreakoutDaysAgo(candles)).toBe(0);
});
it('does not confirm a daily breakout before its session closes', () => {
  const candles = Array.from({ length: 20 }, (_, i) => bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString(), 100, 100));
  candles.push(bar('2026-11-18T09:15:00+05:30', 105, 200));
  expect(findBreakoutDaysAgo(candles, NOW)).toBeNull();
  expect(findBreakoutDaysAgo(candles, new Date('2026-11-18T16:00:00+05:30'))).toBe(0);
});
it('RVOL includes the last completed candle when quote is from the next session', () => {
  const candles = Array.from({ length: 21 }, (_, i) => bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString(), 100, i === 20 ? 1000 : 100));
  expect(computeRVOL(candles, 200, false, '2026-11-18T10:30:00+05:30', NOW)).toMatchObject({
    kind: 'daily-so-far', volume: 200, averageVolume: 190, value: 200 / 190
  });
});
it('RVOL excludes a same-session candle and excludes later candles for an older quote', () => {
  const candles = Array.from({ length: 22 }, (_, i) => bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString(), 100, i >= 20 ? 500 : 100));
  const olderQuote = '2026-10-21T10:30:00+05:30';
  expect(computeRVOL(candles, 200, false, olderQuote, new Date(olderQuote))?.value).toBe(2);
});
it('uses the final daily volume when a closing quote has a lower cumulative count', () => {
  const priorDays = ['04','05','06','08','09','11','12','13','16','17'];
  const candles = [bar('2026-11-03', 100, 1000), ...priorDays.map(day => bar(`2026-11-${day}`, 100, 100)), bar('2026-11-18', 100, 225)];
  expect(computeRVOL(candles, 200, false, '2026-11-18T15:28:00+05:30', new Date('2026-11-18T15:40:00+05:30'))).toMatchObject({
    kind: 'daily-final', volume: 225, averageVolume: 100, value: 2.25
  });
  expect(computeRVOL(candles, 200, false, '2026-11-18T09:08:00+05:30', new Date('2026-11-18T09:10:00+05:30'))).toBeNull();
  expect(computeRVOL(candles, null, false, NOW, NOW)).toBeNull();
  expect(computeRVOL(candles.slice(2), 200, false, NOW, NOW)).toBeNull();
});
it('quant scores have finite zero-to-one-hundred bounds', () => {
  const p = { rsi: 0, rvol: 0, dayChangePct: 0, macdBullish: false, emaTrend: -1, fundamentalScore: 0, closingStrength: 0, sectorBoost: -10 };
  expect(computeQuantScore(p)).toBe(0);
  expect(computeQuantScore({ ...p, closingStrength: NaN })).toBe(0);
  expect(computeQuantScore({ ...p, sectorBoost: 200 })).toBe(100);
});
it('a future candle fails freshness with a specific reason', () => {
  const quality = assessDataQuality(NOW, new Date(+NOW + 86400000), 0, false, NOW);
  expect(quality.stale).toBe(true); expect(quality.issues).toContain('Candle timestamp is in the future');
});
it('partial exit fill prices persist and apply slippage to both legs', () => {
  const signal: PaperSignal = { status: 'OPEN', entryLow: 100, entryHigh: 100, entry: 100, stopLoss: 90, target1: 110, target2: 120, createdAt: '2026-11-18T09:15:00+05:30', filledAt: '2026-11-18T09:15:00+05:30', entryExpiresAt: '2026-11-18T15:00:00+05:30', expiresAt: '2026-11-19T15:00:00+05:30', slippageBps: 100, costBps: 0 };
  const first = evaluatePaperSignal(signal, [{ ...bar('2026-11-18T09:15:00+05:30'), open: 100, low: 99, high: 111, close: 110 }], NOW);
  expect(first.target1Price).toBeCloseTo(108.9);
  const end = evaluatePaperSignal(first, [{ ...bar('2026-11-18T09:30:00+05:30'), open: 110, low: 100, high: 121, close: 120 }], NOW);
  expect(end.realizedR).toBeCloseTo(1.385);
  expect(summarizePaperSignals([{ ...end, evaluationVersion: 2 }]).closed).toBe(0);
  expect(summarizePaperSignals([{ ...end, evaluationVersion: PAPER_EVALUATION_VERSION }]).closed).toBe(1);
});

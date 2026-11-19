import { afterEach, expect, it, vi } from 'vitest';
import type { StockData } from '../src/lib/dataFetcher';
import type { MarketRegimeSnapshot } from '../src/lib/marketRegime';
import { applyInstitutionalGuards } from '../src/lib/riskGuards';
import { runScreener, type ScreenerMode } from '../src/lib/screenerEngine';
import { calendarDay, sessionTime, shiftDate } from '../src/lib/timezone';
import { getTradePlan } from '../src/lib/tradePlan';
import { bar, stock } from './fixtures';

const day = '2026-11-18';
const priorDays: string[] = [];
for (let date = '2026-11-17'; date >= '2026-01-01' && priorDays.length < 205; date = shiftDate(date, -1)) {
  if (calendarDay(date).trading) priorDays.unshift(date);
}

function candle(date: Date, close: number, spread = 1.2, volume = 1e7) {
  return { ...bar(date.toISOString(), close, volume), high: close + spread, low: close - spread };
}

function candidate(mode: ScreenerMode, now: Date): StockData {
  const fixture = stock();
  const candles = priorDays.map((date, i) =>
    candle(sessionTime(date, 555), 100 + 0.025 * (i - 205) + 0.45 * Math.sin(i)));
  const data: StockData = {
    symbol: fixture.symbol, name: 'Synthetic equity', sector: 'IT', candles,
    weeklyCandles: Array.from({ length: 55 }, (_, i) => candle(new Date(Date.UTC(2025, 9, 20 + i * 7)), 86.4 + i * 0.3)),
    monthlyCandles: Array.from({ length: 26 }, (_, i) => candle(new Date(Date.UTC(2024, 8 + i, 2)), 86 + i * 0.5)),
    currentPrice: candles.at(-1)!.close, dayChange: 1, dayChangePercent: 1,
    averageDailyVolume: 1e7, volume: 2e7, quoteVolume: 2e7,
    fundamentals: {
      ...fixture.fundamentals, returnOnEquity: 0.17, revenueGrowth: 0.14, debtToEquity: 30,
      forwardPE: 20, eventStatus: 'known', earningsDate: '2026-12-15T05:30:00Z',
      annualHistory: [2024, 2025, 2026].map((year, i) => ({
        date: `${year}-03-31`, revenue: 120 + i, profit: 20, operatingCashFlow: 25,
        debt: 10, equity: 65, shares: 15,
      })),
    },
    dataQuality: {
      quoteAt: now.toISOString(), candleAt: candles.at(-1)!.date.toISOString(),
      fetchedAt: now.toISOString(), delayMinutes: 0, stale: false, incompleteCandle: false,
      issues: [], sessionEligibility: { day, casEligible: false },
    },
  };
  switch (mode) {
    case 'intraday': {
      const sessionCloses = [100, 100.05, 99.9, 100.65];
      data.candles = [...priorDays.slice(-21), day].flatMap((date, i) => sessionCloses.map((close, slot) => {
        const price = date === day ? close : 100 + 0.025 * (i - 20) + 0.45 * Math.sin(i * 4 + slot);
        return { ...candle(sessionTime(date, 555 + slot * 15), price, 0.2, date === day ? 2e7 : 1e7),
          open: price - 0.05, low: price - 0.4 };
      }));
      data.currentPrice = 100.4;
      break;
    }
    case 'btst': {
      const price = candles.at(-1)!.high;
      data.currentPrice = price;
      data.confirmationCandles = [
        candle(sessionTime(day, 885), price - 0.4),
        { ...candle(sessionTime(day, 900), price, 0.1), open: price - 0.5, low: price - 0.75 },
      ];
      break;
    }
    case 'swing_breakout': {
      const resistance = Math.max(...candles.slice(-22, -2).map(c => c.high));
      Object.assign(candles.at(-2)!, { close: resistance + 0.3, high: resistance + 0.8, volume: 2e7 });
      Object.assign(candles.at(-1)!, { close: resistance + 0.12, high: resistance + 0.4, low: resistance - 0.15 });
      data.currentPrice = resistance + 0.1;
      break;
    }
    case 'swing_pullback':
    case 'positional': {
      const support = mode === 'swing_pullback' ? 99.75 : 99.35;
      Object.assign(candles.at(-1)!, { open: support - 0.4, close: support + 0.7, high: support + 0.9, low: support - 0.5 });
      data.currentPrice = support + 0.75;
      break;
    }
  }
  data.dataQuality!.candleAt = data.candles.at(-1)!.date.toISOString();
  return data;
}

const market: MarketRegimeSnapshot = {
  available: true, regime: 'BULLISH', defensiveMode: false, riskMultiplier: 1, positionRiskPercent: 1,
  reason: 'Fixture', generatedAt: '2026-11-18T04:50:00Z', niftyClose: 100, niftyEma20: 90, niftyEma50: 80, indiaVix: 14,
};

async function evaluate(mode: ScreenerMode, data: StockData) {
  const source = new Map([[data.symbol, data]]);
  const report = { status: 'verified-empty' as const, checkedAt: new Date().toISOString() };
  const instruments = new Map([[data.symbol, {
    symbol: data.symbol, name: data.name, isin: 'INE0D0U01013', tickSize: 0.05,
    casEligible: false, buyAllowed: true, sellAllowed: true,
  }]]);
  return applyInstitutionalGuards(mode, runScreener(mode, source), source, market, undefined, instruments, {
    events: { entries: new Map(), earnings: report, actions: report },
    surveillance: { entries: new Map(), asm: report, gsm: report },
    priceBands: new Map([[data.symbol, { percent: null, publishedDay: '2026-11-17' }]]),
  });
}

type NearMissCase = { mode: ScreenerMode; reason: RegExp; change: (data: StockData) => void };
const cases: NearMissCase[] = [
  { mode: 'intraday', reason: /Intraday RVOL below/, change: data => {
    for (const c of data.candles.slice(-4)) c.volume = 1e7;
  } },
  { mode: 'btst', reason: /BTST momentum candle not confirmed/, change: data => { data.confirmationCandles = []; } },
  { mode: 'swing_breakout', reason: /breakout retest not confirmed/, change: data => { data.candles.at(-1)!.low -= 2; } },
  { mode: 'swing_pullback', reason: /EMA20 reversal not confirmed/, change: data => {
    const last = data.candles.at(-1)!;
    last.open = last.close;
  } },
  { mode: 'positional', reason: /requires reported ROE/, change: data => { data.fundamentals.revenueGrowth = null; } },
  { mode: 'longterm', reason: /Three years of annual financial statements/, change: data => { data.fundamentals.annualHistory = []; } },
];

afterEach(() => vi.useRealTimers());

it.each(cases)('$mode qualifies the intended case, guards a near miss and rejects absent history', async ({ mode, reason, change }) => {
  const now = sessionTime(day, mode === 'btst' ? 920 : mode === 'intraday' ? 620 : 635);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const data = candidate(mode, now);
  const researchOnly = mode === 'longterm';
  const [qualified] = await evaluate(mode, data);
  expect(qualified).toMatchObject({ mode, cmp: data.currentPrice, nearMiss: researchOnly,
    researchQualified: researchOnly, positionRiskPercent: researchOnly ? 0 : 1 });
  if (researchOnly) expect(getTradePlan(qualified)).toBeNull();
  else expect(getTradePlan(qualified)?.accepted).toBe(true);

  const [stale] = await evaluate(mode, { ...data,
    dataQuality: { ...data.dataQuality!, stale: true, issues: ['Stale quote fixture'] } });
  expect(stale).toMatchObject({ nearMiss: true, researchQualified: false, positionRiskPercent: 0 });
  expect(stale.guardReasons).toContain('Stale quote fixture');

  const [staleWithoutDetails] = await evaluate(mode, { ...data,
    dataQuality: { ...data.dataQuality!, stale: true, issues: [] } });
  expect(staleWithoutDetails).toMatchObject({ nearMiss: true, researchQualified: false, positionRiskPercent: 0 });
  expect(staleWithoutDetails.guardReasons).toContain('Data freshness unverified');

  change(data);
  const [near] = await evaluate(mode, data);
  expect(near).toMatchObject({ nearMiss: true, researchQualified: false, positionRiskPercent: 0 });
  expect(near.guardReasons?.join('\n')).toMatch(reason);
  expect(await evaluate(mode, { ...data, candles: data.candles.slice(0, 10) })).toEqual([]);
});

it('keeps the confirmed swing retest and EMA20 pullback criteria distinct on the same inputs', async () => {
  const now = sessionTime(day, 635);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const retest = candidate('swing_breakout', now);
  const pullback = candidate('swing_pullback', now);
  const [asPullback] = await evaluate('swing_pullback', retest);
  const [asBreakout] = await evaluate('swing_breakout', pullback);
  expect(asPullback).toMatchObject({ nearMiss: true, positionRiskPercent: 0 });
  expect(asBreakout).toMatchObject({ nearMiss: true, positionRiskPercent: 0 });
  expect(asBreakout.guardReasons).toContain('Completed breakout retest not confirmed');
});

it('blocks a quote that was valid at acquisition and expires before qualification', async () => {
  const now = sessionTime(day, 635);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const data = candidate('swing_pullback', now);
  data.dataQuality!.quoteAt = new Date(+now - 310_000).toISOString();
  data.dataQuality!.fetchedAt = new Date(+now - 20_000).toISOString();
  const [result] = await evaluate('swing_pullback', data);
  expect(result).toMatchObject({ nearMiss: true, positionRiskPercent: 0,
    dataQuality: { stale: true, fetchedAt: data.dataQuality!.fetchedAt } });
  expect(result.guardReasons).toContain('Quote is stale or outside expected session');
});

it('requires completed higher-timeframe support for Long-Term research even on a low-volume fixture', async () => {
  const now = sessionTime(day, 635);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const data = candidate('longterm', now);
  data.quoteVolume = 1e6;
  data.dayChangePercent = -0.1;
  const [qualified] = await evaluate('longterm', data);
  expect(qualified).toMatchObject({ rvol: 0.1, researchQualified: true, nearMiss: true, positionRiskPercent: 0 });
  const [missingMonthly] = await evaluate('longterm', { ...data, monthlyCandles: [] });
  expect(missingMonthly).toMatchObject({ researchQualified: false, nearMiss: true, positionRiskPercent: 0 });
  expect(missingMonthly.guardReasons).toContain('Completed monthly trend is not confirmed bullish');
});

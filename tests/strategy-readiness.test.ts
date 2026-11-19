import { expect, it, vi } from 'vitest';
import {
  confirmBtstMomentum,
  confirmDailyReversal,
  confirmIntradayBreakout
} from '../src/lib/entrySignals';
import { mergeExchangeClose, parseCashSession, parseIndexSession, restoreCashSpecialSessions } from '../src/lib/nseSessionData';
import { entryExpiry, tradeCosts } from '../src/lib/strategyPolicy';
import { getTradePlan } from '../src/lib/tradePlan';
import { bar, NOW, stock } from './fixtures';

const day = '2026-11-18';
const ist = (time: string) => new Date(`${day}T${time}:00+05:30`);
function candle(time: string, close: number, low = close - 1) {
  return { ...bar(ist(time).toISOString(), close), open: close - 0.5, high: close + 0.1, low };
}

it('accepts a confirmed intraday breakout across consecutive completed bars', () => {
  const candles = [
    candle('09:15', 100),
    candle('09:30', 100),
    candle('09:45', 100),
    candle('10:00', 102)
  ];
  expect(confirmIntradayBreakout(candles, ist('10:19').toISOString(), NOW)?.level).toBe(100.1);
  expect(confirmIntradayBreakout(candles, ist('10:14').toISOString(), NOW)).toBeNull();
  expect(confirmIntradayBreakout(candles, ist('10:35').toISOString(), NOW)).toBeNull();
  candles[0].date = ist('09:00');
  expect(confirmIntradayBreakout(candles, ist('10:19').toISOString(), NOW)).toBeNull();
});

it('requires a completed momentum candle inside the dated BTST window', () => {
  const candles = [candle('14:15', 100), candle('14:30', 101)];
  expect(confirmBtstMomentum(candles, ist('14:46').toISOString(), ist('14:46'))?.level).toBe(100);
  expect(confirmBtstMomentum(candles, ist('14:44').toISOString(), ist('14:46'))).toBeNull();
  expect(confirmBtstMomentum(candles, ist('15:15').toISOString(), ist('15:15'))).toBeNull();
  expect(confirmBtstMomentum(candles.slice(-1), ist('14:46').toISOString(), ist('14:46'))).toBeNull();
});

it('uses the last completed EMA50 reversal and ignores a forming daily bar', () => {
  const history = Array.from({ length: 55 }, (_, i) =>
    bar(new Date(Date.UTC(2026, 8, 15 + i)).toISOString())
  );
  const forming = candle('09:15', 103, 99.5);
  expect(confirmDailyReversal([...history, bar('2026-11-17'), forming], 50, 2, NOW)).toBeNull();
  const completed = { ...forming, date: new Date('2026-11-17T09:15:00+05:30') };
  expect(confirmDailyReversal([...history, completed, forming], 50, 2, NOW)?.at).toBe(
    completed.date.toISOString()
  );
});

it('caps the entry at the cost-adjusted ceiling without increasing the target', () => {
  const setup = stock({
    mode: 'intraday',
    cmp: 100,
    atr: 1,
    breakoutLevel: 99.5,
    defaultSL: 99.25,
    target1: 102,
    target2: 103
  });
  const plan = getTradePlan(setup)!;
  expect(plan.accepted).toBe(true);
  expect(plan.entryHigh).toBeLessThan(100.5);
  expect(plan.target1).toBe(102);
  expect(plan.netRiskReward).toBeGreaterThanOrEqual(plan.minimumNetRR);
  expect(tradeCosts(plan.entryHigh + 0.01, plan.stopLoss, plan.target1).netRR).toBeLessThan(
    plan.minimumNetRR
  );
  expect(getTradePlan({ ...setup, cmp: 100.2 })?.accepted).toBe(false);
  expect(getTradePlan({ ...setup, breakoutLevel: 100.2 })?.reasons[0]).toMatch(/No entry inside/);
});

it('sets expiry using the continuous cash close for the instrument and date', () => {
  expect(entryExpiry('btst', ist('14:50').toISOString())).toBe(ist('15:15').toISOString());
  expect(entryExpiry('btst', ist('14:50').toISOString(), NOW, false)).toBe(ist('15:30').toISOString());
  expect(entryExpiry('btst', '2026-12-07T15:00:00+05:30')).toBe('2026-12-07T10:00:00.000Z');
});

it('keeps a long-term research qualifier out of the mechanical trade plan', () => {
  expect(getTradePlan(stock({ mode: 'longterm', researchQualified: true, nearMiss: true }))).toBeNull();
});

it('parses and joins exact-session NSE cash equity with a matching prior close', () => {
  const csv = [
    'SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, CLOSE_PRICE, TTL_TRD_QNTY',
    'SUNTV, EQ, 18-Nov-2026, 659.70, 670, 700, 660, 696.35, 200000',
    'BAD, BE, 18-Nov-2026, 659.70, 670, 700, 660, 696.35, 200000',
    'OLD, EQ, 17-Nov-2026, 659.70, 670, 700, 660, 696.35, 200000',
    'ZERO, EQ, 18-Nov-2026, 659.70, 670, 700, 660, 696.35, 0'
  ].join('\r\n');
  const data = parseCashSession(csv, day);
  expect([...data.keys()]).toEqual(['SUNTV.NS']);
  const official = data.get('SUNTV.NS')!;
  expect(mergeExchangeClose([bar('2026-11-17', 659.7)], official, day)?.at(-1)?.close).toBe(696.35);
  expect(mergeExchangeClose([bar('2026-11-17', 600)], official, day)).toBeNull();
  expect(mergeExchangeClose([bar('2026-11-16', 659.7)], official, day)).toBeNull();
});

it('validates Nifty and VIX reports against the requested session', () => {
  const csv = [
    'Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Volume',
    'Nifty 50,18-11-2026,25200,25300,25100,25227.95,1000000',
    'India VIX,18-11-2026,15.50,15.80,15.40,15.57,-'
  ].join('\n');
  expect(parseIndexSession(csv, day).get('^INDIAVIX')?.candle.close).toBe(15.57);
  expect(parseIndexSession(csv, day).get('^NSEI')?.candle.close).toBe(25227.95);
  expect(parseIndexSession(csv, '2026-11-19').size).toBe(0);
});

it('restores an omitted special-session candle once while respecting the existing price adjustment',async()=>{
  const csv = [
    'SYMBOL,SERIES,DATE1,PREV_CLOSE,OPEN_PRICE,HIGH_PRICE,LOW_PRICE,CLOSE_PRICE,TTL_TRD_QNTY',
    'ALPHA,EQ,08-Nov-2026,100,100,105,99,104,200000',
    ...Array.from({length:500},(_,i)=>`FILL${i},EQ,08-Nov-2026,100,101,103,98,102,100000`)
  ].join('\n');
  const download=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(csv));
  try {
    const history = [bar('2026-11-06T09:15:00+05:30',100),bar('2026-11-09T09:15:00+05:30',105)];
    const restored = await restoreCashSpecialSessions('ALPHA.NS',history);
    expect(restored.map(item=>item.close)).toEqual([100,104,105]);
    expect(restored[1].restoredFromNse).toBe(true);
    expect(await restoreCashSpecialSessions('ALPHA.NS',restored)).toBe(restored);
    const adjusted = [bar('2026-11-06T09:15:00+05:30',50),history[1]];
    expect(await restoreCashSpecialSessions('ALPHA.NS',adjusted)).toBe(adjusted);
    expect(download).toHaveBeenCalledTimes(1);
  } finally {
    download.mockRestore();
  }
});

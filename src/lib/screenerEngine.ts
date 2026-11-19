import type { ReferenceCoverage } from './entryClearance';
import {
  calcEMA, calcRSI, calcMACD, calcATR, calcVWAP, highestHigh, OHLCV,
} from "./indicators";
import { StockData, FundamentalData } from "./dataFetcher";
import { dateToISTString, latestCompletedSession, todayIST } from "./timezone";
import { computeRVOL, type RelativeVolume } from './relativeVolume';
import type { DataQuality } from './dataQuality';
import { confirmBtstMomentum, confirmDailyReversal, confirmIntradayBreakout } from './entrySignals';
import type { SectorBenchmark } from './sectorBenchmarks';
import type { NseCorporateEvent } from './nseCorporateEvents';
import type { SurveillanceEntry } from './nseSurveillance';
import type { NsePriceBand } from './nsePriceBands';

export type ScreenerMode = "intraday" | "btst" | "swing_breakout" | "swing_pullback" | "positional" | "longterm";

export interface ScreenedStock {
  referenceCoverage?: ReferenceCoverage;
  tickSize?: number;
  tickSizeAsOf?: string;
  casEligible?: boolean;
  breakoutLevel?: number;
  entryConfirmationAt?: string;
  researchQualified?: boolean;
  estimatedCostBps?: number;
  estimatedSlippageBps?: number;
  dataQuality?: DataQuality;
  eventStatus?: 'known' | 'unknown';
  exchangeEvents?: NseCorporateEvent[];
  eventConflict?: boolean;
  surveillance?: SurveillanceEntry[];
  exchangePriceBand?: NsePriceBand;
  guardReasons?: string[];
  primaryRank?: boolean;
  verificationNote?: string;
  monthlyTrend?: 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'UNAVAILABLE';
  symbol: string;
  name: string;
  sector: string;
  cmp: number;
  dayChange: number;
  dayChangePercent: number;
  rsi: number;
  rvol: number;
  relativeVolume?: RelativeVolume | null;
  atr: number;
  ema20: number;
  ema50: number;
  ema200: number | null;
  macdLine: number;
  macdSignal: number;
  vwap: number;
  volume: number;
  quantScore: number;
  mode: ScreenerMode;
  fundamentals: FundamentalData;
  candles: OHLCV[];
  defaultSL: number;
  target1: number;
  target2: number;
  extensionRatio: number;
  vwapExtensionRatio: number;
  extensionWarning: boolean;
  weeklyTrend: "BULLISH" | "NEUTRAL" | "BEARISH" | "UNAVAILABLE";
  breakoutDaysAgo: number | null;
  sectorBoost: number;
  sectorBenchmark?: SectorBenchmark;
  nearMiss?: boolean;
  lifecycleState?: "NEW" | "ACTIVE";
  firstSeenAt?: string;
  lastSeenAt?: string;
  awaitingRevalidation?: boolean;
  earningsDate?: string | null;
  corporateEventDate?: string | null;
  corporateEventType?: string | null;
  earningsRisk?: boolean;
  earningsDaysAway?: number | null;
  liquidityTurnover?: number | null;
  liquidityPass?: boolean;
  circuitLockedRecent?: boolean;
  liquidityWarning?: string;
  sectorCluster?: boolean;
  defensiveMode?: boolean;
  riskMultiplier?: number;
  positionRiskPercent?: number;
  regime?: "BULLISH" | "NEUTRAL" | "BEARISH";
  regimeReason?: string;
}

function safeNum(arr: number[]): number {
  return arr.length > 0 ? arr[arr.length - 1] : 0;
}

function getExtension(cmp: number, ema20: number, vwap: number, atr: number, intraday = false) {
  const extensionRatio = atr > 0 ? Math.max(0, (cmp - ema20) / atr) : 0;
  const vwapExtensionRatio = atr > 0 && vwap > 0 ? Math.max(0, (cmp - vwap) / atr) : 0;
  return {
    extensionRatio,
    vwapExtensionRatio,
    extensionWarning: extensionRatio > 2.5 || (intraday && vwapExtensionRatio > 2),
  };
}

function getWeeklyTrend(candles?: OHLCV[]): "BULLISH" | "NEUTRAL" | "BEARISH" | "UNAVAILABLE" {
  if (!candles || candles.length < 50) return "UNAVAILABLE";
  const closes = candles.map((c) => c.close);
  const ema20 = safeNum(calcEMA(closes, 20));
  const ema50 = safeNum(calcEMA(closes, 50));
  const last = closes.at(-1) ?? 0;
  if (last > ema20 && ema20 > ema50) return "BULLISH";
  if (last < ema20 && ema20 < ema50) return "BEARISH";
  return "NEUTRAL";
}

function completedDailyBars(candles: OHLCV[], now: Date, casEligible: boolean | null): OHLCV[] {
  const completed = latestCompletedSession(now, casEligible);
  return completed ? candles.filter(c => dateToISTString(new Date(c.date)) <= completed) : [];
}
export function findBreakoutDaysAgo(candles: OHLCV[], now = new Date(), casEligible: boolean | null = null): number | null {
  candles = completedDailyBars(candles, now, casEligible);
  for (let daysAgo = 0; daysAgo <= 2; daysAgo++) {
    const index = candles.length - 1 - daysAgo;
    if (index < 20) continue;
    const prior = candles.slice(index - 20, index);
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const averageVolume = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
    const candle = candles[index];
    if (candle.close > priorHigh && candle.volume >= averageVolume * 1.2) return daysAgo;
  }
  return null;
}
export function breakoutRetest(candles: OHLCV[], atr: number, now = new Date(), casEligible: boolean | null = null): { level:number; bar:OHLCV } | null {
  const days = findBreakoutDaysAgo(candles, now, casEligible);
  if (days == null || days===0 || atr<=0) return null;
  const complete=completedDailyBars(candles,now,casEligible), index=complete.length-1-days;
  const level=Math.max(...complete.slice(index-20,index).map(c=>c.high));
  const subsequent=complete.slice(index+1);
  if(subsequent.some(c=>c.close<level))return null;
  const bar=subsequent.at(-1)!;
  return bar.low>=level-0.5*atr&&bar.low<=level+0.25*atr&&bar.close>=level ? {level,bar}:null;
}

function buildSectorBoosts(stocks: Map<string, StockData>): Map<string, number> {
  return new Map([...stocks.values()].map(data => [data.sector ?? 'Unknown', data.sectorBenchmark?.scoreBoost ?? 0]));
}

function currentCas(data: StockData) {
  const eligibility = data.dataQuality?.sessionEligibility;
  return eligibility?.day === todayIST() ? eligibility.casEligible : null;
}

function stockRelativeVolume(data: StockData, intraday = false) {
  const quoteVolume = data.quoteVolume === undefined ? data.volume : data.quoteVolume;
  return computeRVOL(data.candles, quoteVolume, intraday, data.dataQuality?.quoteAt, undefined, currentCas(data));
}

export function sessionVWAP(candles: OHLCV[]): number {
  const date = candles.at(-1)?.date;
  return date ? calcVWAP(candles.filter(c => dateToISTString(new Date(c.date)) === dateToISTString(new Date(date)))) : 0;
}

export function computeQuantScore(params: {
  rsi: number;
  rvol: number;
  dayChangePct: number;
  macdBullish: boolean;
  emaTrend: number; // 1=all bullish, 0=partial, -1=bearish
  fundamentalScore: number; // 0-30
  closingStrength: number; // 0-1
  sectorBoost: number;
}): number {
  if (Object.values(params).some(value => typeof value === 'number' && !Number.isFinite(value))) return 0;
  let score = 0;
  // RSI score (0-20)
  if (params.rsi >= 55 && params.rsi <= 70) score += 20;
  else if (params.rsi >= 50 && params.rsi < 55) score += 12;
  else if (params.rsi > 70 && params.rsi <= 80) score += 10;
  else if (params.rsi >= 45 && params.rsi < 50) score += 6;
  // RVOL score (0-20) — capped at 5x to handle data anomalies
  const rvolCapped = Math.max(0, Math.min(params.rvol, 5));
  if (rvolCapped >= 2.0) score += 20;
  else if (rvolCapped >= 1.5) score += 14;
  else if (rvolCapped >= 1.0) score += 8;
  else score += Math.round(rvolCapped * 4);
  // EMA trend (0-20)
  if (params.emaTrend === 1) score += 20;
  else if (params.emaTrend === 0) score += 10;
  // MACD (0-10)
  if (params.macdBullish) score += 10;
  // Day change (0-10)
  if (params.dayChangePct >= 1.0 && params.dayChangePct <= 5.0) score += 10;
  else if (params.dayChangePct >= 0.3) score += 5;
  else if (params.dayChangePct > 0) score += 2;
  // Closing strength (0-10)
  score += Math.round(Math.max(0, Math.min(1, params.closingStrength)) * 10);
  // Fundamentals (0-10)
  score += Math.min(10, Math.round(params.fundamentalScore / 3));
  // Relative sector strength bonus/penalty (-10 to +10)
  score += params.sectorBoost;
  return Math.max(0, Math.min(100, score));
}

function failedRules(rules: Array<[boolean, string]>): string[] {
  return rules.filter(([passed]) => !passed).map(([, reason]) => reason);
}

/** Rank evaluated symbols, with qualifiers first. */
export function finalizeResults(
  results: ScreenedStock[],
  nearMisses: ScreenedStock[],
  all: ScreenedStock[],
): ScreenedStock[] {
  const qualified = new Set(results.map(s => s.symbol));
  return [...new Map([...results, ...nearMisses, ...all].map(s => [s.symbol, { ...s, nearMiss: !qualified.has(s.symbol) }])).values()].sort((a, b) => Number(a.nearMiss) - Number(b.nearMiss) || b.quantScore - a.quantScore);
}

// ═══════════════════════════════════════════
//  INTRADAY
// ═══════════════════════════════════════════
export function screenIntraday(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 50) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, 20);
    const ema50Arr = calcEMA(closes, 50);
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const vwap = sessionVWAP(candles);
    const relativeVolume = stockRelativeVolume(data, true);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = calcEMA(closes, 200).at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    const extension = getExtension(currentPrice, ema20, vwap, atr, true);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = null;
    const signal=confirmIntradayBreakout(candles,data.dataQuality?.quoteAt, undefined, currentCas(data));

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;
    const emaTrend = currentPrice > ema20 && ema20 > ema50 ? 1 : (currentPrice > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "intraday", fundamentals, candles,
      defaultSL: signal?Math.min(signal.level-0.25*atr,currentPrice-0.25*atr):currentPrice-1.2*atr,
      target1: currentPrice + 2.0 * atr,
      target2: currentPrice + 3.5 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      ...(signal?{breakoutLevel:signal.level,entryConfirmationAt:signal.at}:{}),
      sectorBoost,
    };

    stock.guardReasons = failedRules([
      [signal !== null, 'Completed intraday breakout not confirmed'],
      [!signal || currentPrice >= signal.level, 'Price fell below the intraday breakout level'],
      [currentPrice > vwap, 'Price is at or below session VWAP'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [rvol >= 1.5, (!relativeVolume && data.intradayVolumeNote) || 'Intraday RVOL below 1.5× or baseline unavailable'],
      [rsi >= 55 && rsi <= 80, 'Intraday RSI outside 55–80'],
      [dayChangePercent >= 0.5 && dayChangePercent <= 6, 'Session gain outside 0.5–6%'],
      [atrPct >= 0.3, 'Intraday ATR below 0.3% of price']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

// ═══════════════════════════════════════════
//  BTST
// ═══════════════════════════════════════════
export function screenBTST(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 50) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, 20);
    const ema50Arr = calcEMA(closes, 50);
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const relativeVolume = stockRelativeVolume(data);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = calcEMA(closes, 200).at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles, undefined, currentCas(data));
    const signal=confirmBtstMomentum(data.confirmationCandles??[],data.dataQuality?.quoteAt, undefined, currentCas(data));
    const completedSession=latestCompletedSession(undefined, currentCas(data));
    const prevSessionCandle=completedSession
      ? candles.findLast(candle=>dateToISTString(new Date(candle.date))===completedSession)
      : undefined;

    const lastCandle = candles.at(-1)!;
    const closingStrength = signal?.closingStrength ?? (lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5);
    const emaTrend = currentPrice > ema20 && ema20 > ema50 ? 1 : (currentPrice > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "btst", fundamentals, candles,
      defaultSL: signal ? Math.min(signal.level - 0.15 * atr, currentPrice - 0.25 * atr) : currentPrice * 0.985,
      target1: currentPrice * 1.03,
      target2: currentPrice * 1.055,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      ...(signal?{entryConfirmationAt:signal.at}:{}),
      sectorBoost,
    };

    stock.guardReasons = failedRules([
      [signal !== null, 'Completed late-session BTST momentum candle not confirmed'],
      [!signal || currentPrice >= signal.level, 'Price fell below the BTST momentum candle low'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [!signal || closingStrength >= 0.75, 'Late-session close is outside the top quarter of its range'],
      [rvol >= 1.5, 'BTST RVOL below 1.5× or baseline unavailable'],
      [!!prevSessionCandle && currentPrice >= prevSessionCandle.high * 0.99, 'Price has not reached the prior-session high area'],
      [rsi >= 55, 'Daily RSI below 55']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

// ═══════════════════════════════════════════
//  SWING BREAKOUT
// ═══════════════════════════════════════════
export function screenSwingBreakout(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 55) continue;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, 20);
    const ema50Arr = calcEMA(closes, 50);
    const macdArr = calcMACD(closes);
    const ema200Arr = calcEMA(closes, 200);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const relativeVolume = stockRelativeVolume(data);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = ema200Arr.at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles, undefined, currentCas(data));
    const hh20 = highestHigh(highs, 20);
    const retest = breakoutRetest(candles, atr, undefined, currentCas(data));

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;
    const emaTrend = currentPrice > ema20 && ema20 > ema50 && (ema200 != null && ema50 > ema200) ? 1 :
      (currentPrice > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "swing_breakout", fundamentals, candles,
      defaultSL: retest ? Math.min(retest.bar.low,retest.level) - 0.25*atr : currentPrice - 2 * atr,
      target1: currentPrice + 4 * atr,
      target2: currentPrice + 6 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      ...(retest?{breakoutLevel:retest.level}:{}),
      sectorBoost,
    };

    stock.guardReasons = failedRules([
      [currentPrice > ema20 && ema20 > ema50 && ema200 != null && ema50 > ema200, 'Bullish daily EMA20/50/200 stack unconfirmed'],
      [currentPrice >= 0.97 * hh20, 'Price is more than 3% below its 20-bar high'],
      [retest !== null, 'Completed breakout retest not confirmed'],
      [!retest || (currentPrice >= retest.level && currentPrice <= retest.level + atr), 'Price is outside the breakout retest zone'],
      [weeklyTrend === 'BULLISH', 'Weekly bullish confirmation unavailable'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [rvol >= 1.3, 'Swing breakout RVOL below 1.3× or baseline unavailable'],
      [rsi >= 52 && rsi <= 75, 'Swing breakout RSI outside 52–75'],
      [macdLine > macdSignal, 'Daily MACD is at or below its signal line']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

// ═══════════════════════════════════════════
//  SWING PULLBACK
// ═══════════════════════════════════════════
export function screenSwingPullback(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 55) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, 20);
    const ema50Arr = calcEMA(closes, 50);
    const macdArr = calcMACD(closes);
    const ema200Arr = calcEMA(closes, 200);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const relativeVolume = stockRelativeVolume(data);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = ema200Arr.at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles, undefined, currentCas(data));

    const lastCandle = candles.at(-1)!;
    const distFromEma20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
    const reversal=confirmDailyReversal(candles,20,atr,undefined,currentCas(data));
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;
    const emaTrend = ema20 > ema50 && (ema200 != null && ema50 > ema200) ? 1 : (ema20 > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "swing_pullback", fundamentals, candles,
      defaultSL: currentPrice - 2 * atr,
      target1: currentPrice + 4 * atr,
      target2: currentPrice + 6 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
      ...(reversal?{entryConfirmationAt:reversal.at}:{}),
    };

    stock.guardReasons = failedRules([
      [ema20 > ema50 && ema200 != null && ema50 > ema200, 'Bullish daily EMA20/50/200 stack unconfirmed'],
      [weeklyTrend === 'BULLISH', 'Weekly bullish confirmation unavailable'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [distFromEma20 <= 0.03, 'Price is outside the 3% EMA20 pullback area'],
      [rsi >= 42 && rsi <= 62, 'Swing pullback RSI outside 42–62'],
      [reversal !== null, 'Completed daily EMA20 reversal not confirmed'],
      [!reversal || currentPrice >= reversal.level - 0.25 * atr, 'Price fell below the EMA20 reversal area']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

// ═══════════════════════════════════════════
//  POSITIONAL (Techno-Funda)
// ═══════════════════════════════════════════
export function screenPositional(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 55) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema50Arr = calcEMA(closes, 50);
    const ema200Arr = calcEMA(closes, 200);
    const macdArr = calcMACD(closes);
    const ema20Arr = calcEMA(closes, 20);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const relativeVolume = stockRelativeVolume(data);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = ema200Arr.at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles, undefined, currentCas(data));
    const reversal=confirmDailyReversal(candles,50,atr,undefined,currentCas(data));

    const fg = fundamentals;
    const fundamentalsAvailable = [
      fg.returnOnEquity,
      fg.revenueGrowth,
      fg.earningsGrowth,
      fg.debtToEquity,
      fg.profitMargins,
      fg.forwardPE,
      fg.marketCap,
    ].some((value) => value !== null);
    const fundaOk = fundamentalsAvailable && fg.returnOnEquity !== null
      ? (fg.returnOnEquity ?? 0) >= 0.12 && (fg.revenueGrowth ?? 0) >= 0.10
      : false;

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;

    let fundamentalScore = 0;
    if ((fg.returnOnEquity ?? 0) >= 0.12) fundamentalScore += 10;
    if ((fg.revenueGrowth ?? 0) >= 0.10) fundamentalScore += 10;
    if ((fg.earningsGrowth ?? 0) >= 0.12) fundamentalScore += 10;

    const emaTrend = currentPrice > ema50 && (ema200 != null && ema50 > ema200) ? 1 : ((ema200 != null && currentPrice > ema200) ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "positional", fundamentals, candles,
      defaultSL: currentPrice - 2 * atr,
      target1: currentPrice + 5 * atr,
      target2: currentPrice + 8 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
      ...(reversal?{entryConfirmationAt:reversal.at}:{}),
    };

    stock.guardReasons = failedRules([
      [reversal !== null, 'Completed daily EMA50 reversal not confirmed'],
      [currentPrice > ema50 && ema200 != null && ema50 > ema200, 'Price and EMA50 must be above the long-term trend floor'],
      [rsi >= 52, 'Daily RSI below 52'],
      [weeklyTrend === 'BULLISH', 'Weekly bullish confirmation unavailable'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [fundaOk, 'Positional setup requires reported ROE ≥12% and revenue growth ≥10%']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

// ═══════════════════════════════════════════
//  LONG-TERM
// ═══════════════════════════════════════════
export function screenLongTerm(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 55) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema200Arr = calcEMA(closes, 200);
    const ema50Arr = calcEMA(closes, 50);
    const ema20Arr = calcEMA(closes, 20);
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const relativeVolume = stockRelativeVolume(data);
    const rvol = relativeVolume?.value ?? 0;
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = ema200Arr.at(-1) ?? null;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles, undefined, currentCas(data));

    const fg = fundamentals;
    // Quality score for companies with reported fundamentals.
    const roe = fg.returnOnEquity ?? 0;
    const de = fg.debtToEquity ?? 100;
    const revGrowth = fg.revenueGrowth ?? 0;
    const margins = fg.profitMargins ?? 0;

    const fundamentalsAvailable = [
      fg.returnOnEquity,
      fg.revenueGrowth,
      fg.earningsGrowth,
      fg.debtToEquity,
      fg.profitMargins,
      fg.forwardPE,
      fg.marketCap,
    ].some((value) => value !== null);
    const fundaOk = fundamentalsAvailable && roe >= 0.12;

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;

    let fundamentalScore = 0;
    if (roe >= 0.15) fundamentalScore += 10;
    else if (roe >= 0.10) fundamentalScore += 6;
    if (de <= 50 && fg.debtToEquity !== null) fundamentalScore += 10;
    if (revGrowth >= 0.10) fundamentalScore += 5;
    if (margins >= 0.08) fundamentalScore += 5;

    const emaTrend = (ema200 != null && currentPrice > ema200) ? 1 : -1;
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, relativeVolume, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "longterm", fundamentals, candles,
      defaultSL: currentPrice * 0.92,
      target1: currentPrice * 1.20,
      target2: currentPrice * 1.40,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    stock.guardReasons = failedRules([
      [ema200 != null && currentPrice > ema200, 'Price above daily EMA200 unconfirmed'],
      [fundaOk, 'Long-term shortlist requires reported ROE ≥12%'],
      [weeklyTrend === 'BULLISH', 'Weekly bullish confirmation unavailable'],
      [!extension.extensionWarning, 'Extended move — wait for a pullback'],
      [fg.debtToEquity != null && de <= 100, 'Reported debt-to-equity above 1× or unavailable'],
      [rsi >= 45, 'Daily RSI below 45']
    ]);
    allStocks.push(stock);
    if (!stock.guardReasons.length) results.push(stock);
  }

  return finalizeResults(results, [], allStocks);
}

export function runScreener(mode: ScreenerMode, stocks: Map<string, StockData>): ScreenedStock[] {
  const engines = { intraday: screenIntraday, btst: screenBTST, swing_breakout: screenSwingBreakout, swing_pullback: screenSwingPullback, positional: screenPositional, longterm: screenLongTerm };
  const engine = engines[mode];
  if (!engine) return [];
  return engine(stocks).map(stock => {
    const data = stocks.get(stock.symbol)!;
    const reasons = [...(stock.guardReasons ?? [])];
    if (!['intraday', 'btst'].includes(mode) && stock.ema200 == null) reasons.push('EMA200 requires at least 200 candles; history is insufficient');
    return { ...stock, sectorBenchmark:data.sectorBenchmark, dataQuality: data.dataQuality, guardReasons: reasons };
  });
}

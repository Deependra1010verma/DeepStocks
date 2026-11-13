import {
  calcEMA, calcRSI, calcMACD, calcATR, calcSMA, calcVWAP, highestHigh, OHLCV,
} from "./indicators";
import { StockData, FundamentalData } from "./dataFetcher";
import { todayIST, dateToISTString } from "./timezone";

export type ScreenerMode = "intraday" | "btst" | "swing_breakout" | "swing_pullback" | "positional" | "longterm";

export interface ScreenedStock {
  symbol: string;
  name: string;
  sector: string;
  cmp: number;
  dayChange: number;
  dayChangePercent: number;
  rsi: number;
  rvol: number;
  atr: number;
  ema20: number;
  ema50: number;
  ema200: number;
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
  nearMiss?: boolean;
}

function safeNum(arr: number[]): number {
  return arr.length > 0 ? arr[arr.length - 1] : 0;
}

function getExtension(cmp: number, ema20: number, vwap: number, atr: number) {
  const extensionRatio = atr > 0 ? Math.max(0, (cmp - ema20) / atr) : 0;
  const vwapExtensionRatio = atr > 0 && vwap > 0 ? Math.max(0, (cmp - vwap) / atr) : 0;
  return {
    extensionRatio,
    vwapExtensionRatio,
    extensionWarning: extensionRatio > 2.5 || vwapExtensionRatio > 2,
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

function findBreakoutDaysAgo(candles: OHLCV[]): number | null {
  for (let daysAgo = 0; daysAgo <= 2; daysAgo++) {
    const index = candles.length - 1 - daysAgo;
    if (index < 21) continue;
    const prior = candles.slice(index - 20, index);
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const averageVolume = prior.reduce((sum, c) => sum + c.volume, 0) / prior.length;
    const candle = candles[index];
    if (candle.close >= priorHigh * 0.995 && candle.volume >= averageVolume * 1.2) return daysAgo;
  }
  return null;
}

function buildSectorBoosts(stocks: Map<string, StockData>): Map<string, number> {
  const bySector = new Map<string, number[]>();
  for (const data of stocks.values()) {
    const sector = data.sector ?? "Unknown";
    const values = bySector.get(sector) ?? [];
    values.push(data.dayChangePercent);
    bySector.set(sector, values);
  }
  const averages = [...bySector.entries()].map(([sector, values]) => ({
    sector,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  }));
  const sorted = averages.map((entry) => entry.average).sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  return new Map(averages.map(({ sector, average }) => [
    sector,
    Math.max(-10, Math.min(10, Math.round((average - median) * 3))),
  ]));
}

/** Compute RVOL properly from daily candle volumes (last 20 days avg vs last day) */
function computeRVOL(candles: OHLCV[], quoteVolume: number, isIntraday: boolean): number {
  if (candles.length < 5) return 1;
  if (isIntraday) {
    // For 15m candles: sum all candles from today, compare to avg day volume from last 10 days
    const todayStr = todayIST();
    const todayCandles = candles.filter(c => dateToISTString(new Date(c.date)) === todayStr);
    const todayVol = todayCandles.reduce((s, c) => s + c.volume, 0);
    // Avg daily volume: take 10 days excluding today
    const otherDays = new Map<string, number>();
    for (const c of candles) {
      const d = dateToISTString(new Date(c.date));
      if (d !== todayStr) otherDays.set(d, (otherDays.get(d) ?? 0) + c.volume);
    }
    const dayVols = Array.from(otherDays.values()).slice(-10);
    if (dayVols.length === 0) return 1;
    const avgDayVol = dayVols.reduce((a, b) => a + b, 0) / dayVols.length;
    return avgDayVol > 0 ? (todayVol > 0 ? todayVol / avgDayVol : quoteVolume / avgDayVol) : 1;
  }
  // Daily candles: use last candle volume vs 20-day SMA of volumes
  const vols = candles.map(c => c.volume);
  const sma = calcSMA(vols, 20);
  const avgVol = safeNum(sma);
  const lastVol = quoteVolume > 0 ? quoteVolume : (vols.at(-1) ?? 0);
  return avgVol > 0 ? lastVol / avgVol : 1;
}

function computeQuantScore(params: {
  rsi: number;
  rvol: number;
  dayChangePct: number;
  macdBullish: boolean;
  emaTrend: number; // 1=all bullish, 0=partial, -1=bearish
  fundamentalScore: number; // 0-30
  closingStrength: number; // 0-1
  sectorBoost: number;
}): number {
  let score = 0;
  // RSI score (0-20)
  if (params.rsi >= 55 && params.rsi <= 70) score += 20;
  else if (params.rsi >= 50 && params.rsi < 55) score += 12;
  else if (params.rsi > 70 && params.rsi <= 80) score += 10;
  else if (params.rsi >= 45 && params.rsi < 50) score += 6;
  // RVOL score (0-20) — capped at 5x to handle data anomalies
  const rvolCapped = Math.min(params.rvol, 5);
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
  score += Math.round(params.closingStrength * 10);
  // Fundamentals (0-10)
  score += Math.min(10, Math.round(params.fundamentalScore / 3));
  // Relative sector strength bonus/penalty (-10 to +10)
  score += params.sectorBoost;
  return Math.min(100, score);
}

/** Always return something — if no qualified, expand near-miss; if still nothing, return top-N by score */
function finalizeResults(
  results: ScreenedStock[],
  nearMisses: ScreenedStock[],
  all: ScreenedStock[],
  topN = 10,
  nearN = 5
): ScreenedStock[] {
  if (results.length > 0) {
    return results.sort((a, b) => b.quantScore - a.quantScore).slice(0, topN);
  }
  if (nearMisses.length > 0) {
    return nearMisses.sort((a, b) => b.quantScore - a.quantScore).slice(0, nearN).map(s => ({ ...s, nearMiss: true }));
  }
  // Last resort: show top stocks by quantScore anyway (marked nearMiss)
  return all.sort((a, b) => b.quantScore - a.quantScore).slice(0, nearN).map(s => ({ ...s, nearMiss: true }));
}

// ═══════════════════════════════════════════
//  INTRADAY
// ═══════════════════════════════════════════
export function screenIntraday(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 15) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, Math.min(20, closes.length - 1));
    const ema50Arr = calcEMA(closes, Math.min(50, closes.length - 1));
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const vwap = calcVWAP(candles.slice(-20));
    const rvol = computeRVOL(candles, volume, true);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = calcEMA(closes, Math.min(200, closes.length - 1)).at(-1) ?? ema50;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);

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
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "intraday", fundamentals, candles,
      defaultSL: currentPrice - 1.2 * atr,
      target1: currentPrice + 2.0 * atr,
      target2: currentPrice + 3.5 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    const passesAllFilters =
      currentPrice > vwap &&
      !extension.extensionWarning &&
      rvol >= 1.5 &&
      rsi >= 55 && rsi <= 80 &&
      dayChangePercent >= 0.5 && dayChangePercent <= 6 &&
      atrPct >= 0.3;

    if (passesAllFilters) results.push(stock);
    else if (rvol >= 1.0 && rsi >= 48 && dayChangePercent >= 0.2) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

// ═══════════════════════════════════════════
//  BTST
// ═══════════════════════════════════════════
export function screenBTST(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 20) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema20Arr = calcEMA(closes, Math.min(20, closes.length - 1));
    const ema50Arr = calcEMA(closes, Math.min(50, closes.length - 1));
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const rvol = computeRVOL(candles, volume, false);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = calcEMA(closes, Math.min(200, closes.length - 1)).at(-1) ?? ema50;
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);

    const lastCandle = candles.at(-1)!;
    const prevCandle = candles.at(-2)!;
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
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "btst", fundamentals, candles,
      defaultSL: currentPrice * 0.985,
      target1: currentPrice * 1.03,
      target2: currentPrice * 1.055,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    const passesAllFilters =
      !extension.extensionWarning &&
      closingStrength >= 0.75 &&
      rvol >= 1.5 &&
      lastCandle.close >= prevCandle.high * 0.99 &&
      rsi >= 55;

    if (passesAllFilters) results.push(stock);
    else if (closingStrength >= 0.6 && rsi >= 48) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

// ═══════════════════════════════════════════
//  SWING BREAKOUT
// ═══════════════════════════════════════════
export function screenSwingBreakout(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
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
    const ema200Arr = calcEMA(closes, Math.min(200, closes.length - 1));

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const rvol = computeRVOL(candles, volume, false);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = safeNum(ema200Arr);
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);
    const hh20 = highestHigh(highs, 20);

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;
    const emaTrend = currentPrice > ema20 && ema20 > ema50 && ema50 > ema200 ? 1 :
      (currentPrice > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "swing_breakout", fundamentals, candles,
      defaultSL: currentPrice - 2 * atr,
      target1: currentPrice + 4 * atr,
      target2: currentPrice + 6 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    const passesAllFilters =
      currentPrice > ema20 && ema20 > ema50 && ema50 > ema200 &&   // EMA stack
      currentPrice >= 0.97 * hh20 &&                                // Near 20-day high
      breakoutDaysAgo !== null &&                                  // Breakout today or within last 3 sessions
      weeklyTrend !== "BEARISH" &&                                 // Weekly confirmation
      !extension.extensionWarning &&                               // Do not chase extended moves
      rvol >= 1.3 &&                                                 // Above avg volume
      rsi >= 52 && rsi <= 75 &&
      macdLine > macdSignal;

    if (passesAllFilters) results.push(stock);
    else if (currentPrice > ema20 && ema20 > ema50 && rsi >= 48) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

// ═══════════════════════════════════════════
//  SWING PULLBACK
// ═══════════════════════════════════════════
export function screenSwingPullback(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
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
    const ema200Arr = calcEMA(closes, Math.min(200, closes.length - 1));

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const rvol = computeRVOL(candles, volume, false);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = safeNum(ema200Arr);
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);

    const lastCandle = candles.at(-1)!;
    const distFromEma20 = ema20 > 0 ? Math.abs(currentPrice - ema20) / ema20 : 1;
    const isBullishCandle = lastCandle.close > lastCandle.open;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;
    const emaTrend = ema20 > ema50 && ema50 > ema200 ? 1 : (ema20 > ema50 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore: 0, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "swing_pullback", fundamentals, candles,
      defaultSL: currentPrice - 2 * atr,
      target1: currentPrice + 4 * atr,
      target2: currentPrice + 6 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    const passesAllFilters =
      ema20 > ema50 && ema50 > ema200 &&
      weeklyTrend !== "BEARISH" &&
      !extension.extensionWarning &&
      distFromEma20 <= 0.03 &&
      rsi >= 42 && rsi <= 62 &&
      isBullishCandle;

    if (passesAllFilters) results.push(stock);
    else if (ema20 > ema50 && distFromEma20 <= 0.08 && rsi >= 38) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

// ═══════════════════════════════════════════
//  POSITIONAL (Techno-Funda)
// ═══════════════════════════════════════════
export function screenPositional(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
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
    const ema200Arr = calcEMA(closes, Math.min(200, closes.length - 1));
    const macdArr = calcMACD(closes);
    const ema20Arr = calcEMA(closes, 20);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const rvol = computeRVOL(candles, volume, false);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = safeNum(ema200Arr);
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);

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

    const passesAllFilters =
      currentPrice > ema50 && ema50 > ema200 &&
      rsi >= 52 &&
      weeklyTrend === "BULLISH" &&
      !extension.extensionWarning &&
      fundaOk;

    const lastCandle = candles.at(-1)!;
    const closingStrength = lastCandle.high !== lastCandle.low
      ? (lastCandle.close - lastCandle.low) / (lastCandle.high - lastCandle.low)
      : 0.5;

    let fundamentalScore = 0;
    if ((fg.returnOnEquity ?? 0) >= 0.12) fundamentalScore += 10;
    if ((fg.revenueGrowth ?? 0) >= 0.10) fundamentalScore += 10;
    if ((fg.earningsGrowth ?? 0) >= 0.12) fundamentalScore += 10;

    const emaTrend = currentPrice > ema50 && ema50 > ema200 ? 1 : (currentPrice > ema200 ? 0 : -1);
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "positional", fundamentals, candles,
      defaultSL: currentPrice - 2 * atr,
      target1: currentPrice + 5 * atr,
      target2: currentPrice + 8 * atr,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    if (passesAllFilters) results.push(stock);
    else if (currentPrice > ema50 && rsi >= 45) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

// ═══════════════════════════════════════════
//  LONG-TERM
// ═══════════════════════════════════════════
export function screenLongTerm(stocks: Map<string, StockData>): ScreenedStock[] {
  const results: ScreenedStock[] = [];
  const nearMisses: ScreenedStock[] = [];
  const allStocks: ScreenedStock[] = [];
  const sectorBoosts = buildSectorBoosts(stocks);

  for (const [symbol, data] of stocks) {
    const sectorBoost = sectorBoosts.get(data.sector ?? "Unknown") ?? 0;
    const { candles, currentPrice, dayChangePercent, volume, fundamentals, name } = data;
    if (candles.length < 55) continue;

    const closes = candles.map((c) => c.close);
    const rsiArr = calcRSI(closes);
    const atrArr = calcATR(candles);
    const ema200Arr = calcEMA(closes, Math.min(200, closes.length - 1));
    const ema50Arr = calcEMA(closes, 50);
    const ema20Arr = calcEMA(closes, 20);
    const macdArr = calcMACD(closes);

    const rsi = safeNum(rsiArr);
    const atr = safeNum(atrArr);
    const rvol = computeRVOL(candles, volume, false);
    const ema20 = safeNum(ema20Arr);
    const ema50 = safeNum(ema50Arr);
    const ema200 = safeNum(ema200Arr);
    const macdLast = macdArr.at(-1);
    const macdLine = macdLast?.MACD ?? 0;
    const macdSignal = macdLast?.signal ?? 0;
    const vwap = calcVWAP(candles.slice(-20));
    const extension = getExtension(currentPrice, ema20, vwap, atr);
    const weeklyTrend = getWeeklyTrend(data.weeklyCandles);
    const breakoutDaysAgo = findBreakoutDaysAgo(candles);

    const fg = fundamentals;
    // Quality score — allow if any fundamentals look good
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

    const passesAllFilters =
      currentPrice > ema200 &&
      fundaOk &&
      weeklyTrend !== "BEARISH" &&
      !extension.extensionWarning &&
      (de <= 100 || fg.debtToEquity === null) && // relaxed D/E since Yahoo gives weird values
      rsi >= 45;

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

    const emaTrend = currentPrice > ema200 ? 1 : -1;
    const quantScore = computeQuantScore({
      rsi, rvol, dayChangePct: dayChangePercent, macdBullish: macdLine > macdSignal,
      emaTrend, fundamentalScore, closingStrength, sectorBoost,
    });

    const stock: ScreenedStock = {
      symbol, name, sector: data.sector ?? "", cmp: currentPrice, dayChange: data.dayChange,
      dayChangePercent, rsi, rvol, atr, ema20, ema50, ema200, macdLine, macdSignal,
      vwap, volume, quantScore, mode: "longterm", fundamentals, candles,
      defaultSL: currentPrice * 0.92,
      target1: currentPrice * 1.20,
      target2: currentPrice * 1.40,
      ...extension,
      weeklyTrend,
      breakoutDaysAgo,
      sectorBoost,
    };

    allStocks.push(stock);

    if (passesAllFilters) results.push(stock);
    else if (currentPrice > ema200) {
      nearMisses.push(stock);
    }
  }

  return finalizeResults(results, nearMisses, allStocks);
}

export function runScreener(mode: ScreenerMode, stocks: Map<string, StockData>): ScreenedStock[] {
  switch (mode) {
    case "intraday":        return screenIntraday(stocks);
    case "btst":            return screenBTST(stocks);
    case "swing_breakout":  return screenSwingBreakout(stocks);
    case "swing_pullback":  return screenSwingPullback(stocks);
    case "positional":      return screenPositional(stocks);
    case "longterm":        return screenLongTerm(stocks);
    default:                return [];
  }
}

import * as TI from "technicalindicators";

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  date: Date;
}

export function calcEMA(closes: number[], period: number): number[] {
  return TI.EMA.calculate({ period, values: closes });
}

export function calcRSI(closes: number[], period = 14): number[] {
  return TI.RSI.calculate({ period, values: closes });
}

export function calcMACD(closes: number[]): { MACD: number; signal: number; histogram: number }[] {
  return TI.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  }) as { MACD: number; signal: number; histogram: number }[];
}

export function calcATR(candles: OHLCV[], period = 14): number[] {
  return TI.ATR.calculate({
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    period,
  });
}

export function calcSMA(values: number[], period: number): number[] {
  return TI.SMA.calculate({ period, values });
}

export function calcVWAP(candles: OHLCV[]): number {
  let cumTPV = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : 0;
}

export function highestHigh(highs: number[], period: number): number {
  const slice = highs.slice(-period);
  return Math.max(...slice);
}

import { calcEMA, type OHLCV } from './indicators';
import {
  cashSessionLimits,
  dateToISTString,
  getMarketSession,
  isContinuous15mBar,
  latestCompletedSession,
  minutesIST
} from './timezone';

const BAR_MS = 15 * 60_000;

function completedSessionBars(candles: OHLCV[], quoteAt: string | null | undefined, now: Date) {
  const cutoff = quoteAt ? Math.min(+now, Date.parse(quoteAt)) : NaN;
  const day = dateToISTString(now);
  if (getMarketSession(now).state !== 'LIVE' || !Number.isFinite(cutoff)) return [];
  const bars = candles.filter((bar) => {
    const at = new Date(bar.date);
    return (
      +at + BAR_MS <= cutoff &&
      dateToISTString(at) === day &&
      isContinuous15mBar(at)
    );
  });
  const latest = bars.at(-1);
  return latest && cutoff - +new Date(latest.date) - BAR_MS < BAR_MS ? bars : [];
}
function consecutive(bars: OHLCV[]) {
  return bars.every(
    (bar, index) => !index || +new Date(bar.date) - +new Date(bars[index - 1].date) === BAR_MS
  );
}
export function confirmIntradayBreakout(
  candles: OHLCV[],
  quoteAt: string | null | undefined,
  now = new Date()
) {
  const bars = completedSessionBars(candles, quoteAt, now);
  if (bars.length < 4 || !consecutive(bars.slice(-4))) return null;
  const signal = bars.at(-1)!;
  const prior = bars.slice(-4, -1);
  const level = Math.max(...prior.map((bar) => bar.high));
  return signal.close > level && signal.close > signal.open
    ? { at: new Date(signal.date).toISOString(), level }
    : null;
}
export function isBtstWindow(now = new Date()) {
  const close = cashSessionLimits(dateToISTString(now)).continuousEnd;
  return (
    getMarketSession(now).state === 'LIVE' && minutesIST(now) >= close - 30 && minutesIST(now) < close
  );
}
export function confirmBtstMomentum(
  candles: OHLCV[],
  quoteAt: string | null | undefined,
  now = new Date()
) {
  if (!isBtstWindow(now)) return null;
  const bars = completedSessionBars(candles, quoteAt, now);
  const signal = bars.at(-1),
    prior = bars.at(-2);
  if (!signal || !prior || signal.high <= signal.low || !consecutive([prior, signal])) return null;
  const close = cashSessionLimits(dateToISTString(now)).continuousEnd;
  const time = minutesIST(new Date(signal.date)) + 15;
  const closingStrength = (signal.close - signal.low) / (signal.high - signal.low);
  return time >= close - 30 &&
    signal.close > signal.open &&
    signal.close > prior.close &&
    closingStrength >= 0.65
    ? { at: new Date(signal.date).toISOString(), level: signal.low, closingStrength }
    : null;
}
export function confirmDailyReversal(candles: OHLCV[], period: 20 | 50, atr: number, now = new Date()) {
  const session = latestCompletedSession(now);
  if (!session || !(atr > 0)) return null;
  const completed = candles.filter((bar) => dateToISTString(new Date(bar.date)) <= session);
  const signal = completed.at(-1);
  if (!signal || dateToISTString(new Date(signal.date)) !== session) return null;
  const average = calcEMA(
    completed.map((bar) => bar.close),
    period
  ).at(-1);
  return average &&
    signal.close > signal.open &&
    signal.close >= average &&
    Math.abs(signal.low - average) <= atr
    ? { at: new Date(signal.date).toISOString(), level: average }
    : null;
}

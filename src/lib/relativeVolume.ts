import type { OHLCV } from './indicators';
import { dateToISTString, latestCompletedSession, minutesIST } from './timezone';

export const RVOL_SESSIONS = 10;
const BAR_MS = 15 * 60_000;
const SESSION_OPEN = 9 * 60 + 15;

export interface RelativeVolume {
  value: number;
  volume: number;
  averageVolume: number;
  session: string;
  kind: 'daily-final' | 'daily-so-far' | 'intraday-cumulative';
  through?: string;
}

function validVolume(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function ratio(volume: number, prior: number[], session: string, kind: RelativeVolume['kind'], through?: string): RelativeVolume | null {
  if (prior.length !== RVOL_SESSIONS) return null;
  const averageVolume = prior.reduce((sum, day) => sum + day, 0) / RVOL_SESSIONS;
  return averageVolume > 0 && Number.isFinite(averageVolume)
    ? { value: volume / averageVolume, volume, averageVolume, session, kind, through }
    : null;
}

function dailyVolume(candles: OHLCV[], quoteVolume: number | null, quote: Date | null, now: Date) {
  const completed = latestCompletedSession(now);
  const session = quote ? dateToISTString(quote) : completed;
  if (!session) return null;
  const isCompleted = Boolean(completed && session <= completed);
  if (!isCompleted && quote && minutesIST(quote) < SESSION_OPEN) return null;

  let finalVolume: number | undefined;
  const prior = new Map<string, number>();
  for (let i = candles.length - 1; i >= 0 && prior.size < RVOL_SESSIONS; i--) {
    const bar = candles[i];
    const day = dateToISTString(new Date(bar.date));
    if (day > session || !validVolume(bar.volume)) continue;
    if (day === session) {
      if (isCompleted) finalVolume ??= bar.volume;
    } else if (!prior.has(day)) {
      prior.set(day, bar.volume);
    }
  }

  const volume = finalVolume ?? (quote ? quoteVolume : null);
  if (!validVolume(volume)) return null;
  return ratio(volume, [...prior.values()], session, finalVolume === undefined ? 'daily-so-far' : 'daily-final',
    finalVolume === undefined ? quote?.toISOString() : undefined);
}

function volumeThrough(slots: Map<number, number>, lastMinute: number): number | null {
  let sum = 0;
  for (let minute = SESSION_OPEN; minute <= lastMinute; minute += 15) {
    const volume = slots.get(minute);
    if (volume === undefined) return null;
    sum += volume;
  }
  return Number.isFinite(sum) ? sum : null;
}

function intradayVolume(candles: OHLCV[], quote: Date | null, now: Date) {
  const quoteDay = quote ? dateToISTString(quote) : null;
  const completed = latestCompletedSession(now);
  // For a completed session the final chart bar can end after the last individual trade.
  const cutoff = quote && quoteDay && (!completed || quoteDay > completed) ? +quote : +now;
  const days = new Map<string, Map<number, number>>();
  for (const bar of candles) {
    const at = new Date(bar.date);
    const minute = minutesIST(at);
    if (!(minute >= SESSION_OPEN && minute < 930) || +at % BAR_MS !== 0 || +at + BAR_MS > cutoff || !validVolume(bar.volume)) continue;
    const day = dateToISTString(at);
    const slots = days.get(day) ?? new Map<number, number>();
    slots.set(minute, bar.volume);
    days.set(day, slots);
  }

  const session = quoteDay ?? [...days.keys()].at(-1);
  const current = session ? days.get(session) : undefined;
  if (!session || !current) return null;
  const lastMinute = Math.max(...current.keys());
  const volume = volumeThrough(current, lastMinute);
  if (volume === null) return null;

  const prior: number[] = [];
  for (const [day, slots] of [...days].reverse()) {
    if (day >= session) continue;
    const comparable = volumeThrough(slots, lastMinute);
    if (comparable === null) continue;
    prior.push(comparable);
    if (prior.length === RVOL_SESSIONS) break;
  }
  const through = new Date(+new Date(`${session}T00:00:00+05:30`) + (lastMinute + 15) * 60_000);
  return ratio(volume, prior, session, 'intraday-cumulative', through.toISOString());
}

export function computeRVOL(
  candles: OHLCV[], quoteVolume: number | null, isIntraday: boolean,
  quoteAt?: Date | string | null, now = new Date()
): RelativeVolume | null {
  const quote = quoteAt ? new Date(quoteAt) : null;
  if (quote && (!Number.isFinite(+quote) || quote > now)) return null;
  return isIntraday ? intradayVolume(candles, quote, now) : dailyVolume(candles, quoteVolume, quote, now);
}

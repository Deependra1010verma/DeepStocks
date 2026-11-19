import type { ScreenerMode, ScreenedStock } from './screenerEngine';
import {
  dateToISTString,
  getMarketSession,
  nextMarketOpen,
  shiftDate,
  calendarDay,
  cashSessionLimits
} from './timezone';
export const STRATEGY_VERSION = '2026-11-risk-v6';
export const STRATEGY_POLICIES: Record<
  ScreenerMode,
  { trigger: string; minNetRR: number; entrySessions: number }
> = {
  intraday: {
    trigger:
      'After a completed 15-minute breakout candle, enter only inside the zone during continuous trading; do not chase above the zone.',
    minNetRR: 1.5,
    entrySessions: 1
  },
  btst: {
    trigger:
      'Require a completed 15-minute momentum candle in the final 30 minutes of continuous trading and verified overnight-event clearance. Review exit next exchange session.',
    minNetRR: 1.5,
    entrySessions: 1
  },
  swing_breakout: {
    trigger:
      'Require a completed daily close above the preceding 20-bar high; enter on a retest that holds the breakout level inside the zone.',
    minNetRR: 1.5,
    entrySessions: 3
  },
  swing_pullback: {
    trigger:
      'Require a completed bullish rejection of the EMA20 pullback area in a bullish weekly trend; enter only inside the zone.',
    minNetRR: 1.5,
    entrySessions: 3
  },
  positional: {
    trigger:
      'Require confirmed daily/weekly trend and dated fundamental clearance; enter inside the pullback zone after a completed reversal candle.',
    minNetRR: 2,
    entrySessions: 3
  },
  longterm: {
    trigger:
      'Research only until multi-year cash flow, valuation assumptions and monthly pullback evidence are reviewed; no automatic investment approval.',
    minNetRR: 2,
    entrySessions: 5
  }
};
export function entryExpiry(
  mode: ScreenerMode,
  referenceAt: string | undefined,
  now = new Date(),
  casEligible: boolean | null = null
): string {
  const reference =
    referenceAt && Number.isFinite(Date.parse(referenceAt)) ? new Date(referenceAt) : now;
  let day = dateToISTString(reference);
  if (getMarketSession(reference, casEligible).state !== 'LIVE')
    day = dateToISTString(nextMarketOpen(reference));
  let remaining = STRATEGY_POLICIES[mode].entrySessions - 1;
  for (let i = 0; remaining > 0 && i < 20; i++) {
    day = shiftDate(day, 1);
    if (!calendarDay(day).verified) return reference.toISOString();
    if (calendarDay(day).trading) remaining--;
  }
  const close = cashSessionLimits(day, casEligible).continuousEnd;
  return new Date(+new Date(`${day}T00:00:00+05:30`) + close * 60_000).toISOString();
}
export function tradeCosts(entry: number, stop: number, target: number, costBps = 20, slippageBps = 5) {
  const fee = (entry * costBps) / 10000,
    slip = slippageBps / 10000;
  const risk = entry * (1 + slip) - stop * (1 - slip) + fee;
  const reward = target * (1 - slip) - entry * (1 + slip) - fee;
  return { risk, reward, netRR: risk > 0 ? reward / risk : 0, cashPerShare: entry * (1 + slip) + fee };
}
export function rewardRiskEntryCeiling(
  stop: number,
  target: number,
  minRR: number,
  costBps: number,
  slippageBps: number
) {
  const slip = slippageBps / 10000,
    fee = costBps / 10000;
  return ((target + minRR * stop) * (1 - slip)) / ((1 + minRR) * (1 + slip + fee));
}
export function entryEvidence(stock: Partial<ScreenedStock>): string[] {
  const reasons: string[] = [];
  if (!stock.mode) return ['Strategy unavailable'];
  if (stock.mode === 'intraday' && !stock.entryConfirmationAt)
    reasons.push('Completed intraday breakout not confirmed');
  if (stock.mode === 'btst' && !stock.entryConfirmationAt)
    reasons.push('Completed late-session BTST momentum candle not confirmed');
  if (stock.mode === 'swing_pullback' && !stock.entryConfirmationAt)
    reasons.push('Completed daily EMA20 reversal not confirmed');
  if (stock.mode === 'positional' && !stock.entryConfirmationAt)
    reasons.push('Completed daily EMA50 reversal not confirmed');
  if (stock.mode === 'swing_breakout' && stock.breakoutDaysAgo == null)
    reasons.push('Completed daily breakout is not confirmed');
  if (
    ['swing_pullback', 'positional', 'longterm'].includes(stock.mode) &&
    stock.weeklyTrend !== 'BULLISH'
  )
    reasons.push('Weekly trend confirmation unavailable');
  if (stock.mode === 'swing_breakout' && stock.breakoutDaysAgo === 0)
    reasons.push('Breakout retest has not yet been confirmed on a later completed candle');
  if (stock.mode === 'longterm') reasons.push('Long-term thesis and valuation require manual review');
  return reasons;
}

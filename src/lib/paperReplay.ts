import {
  evaluatePaperSignal,
  PAPER_EVALUATION_VERSION,
  summarizePaperSignals,
  type PaperSignal
} from './ledgerEngine';
import type { OHLCV } from './indicators';
export interface ReplayCase {
  id: string;
  symbol: string;
  strategyVersion: string;
  decisionAt: string;
  inputsAvailableAt: string;
  signal: PaperSignal;
  bars: Array<Omit<OHLCV, 'date'> & { date: string }>;
}
export function replayHoldout(input: {
  source: string;
  tuneThrough: string;
  holdoutThrough: string;
  strategyVersion: string;
  cases: ReplayCase[];
}) {
  const start = Date.parse(input.tuneThrough),
    end = Date.parse(input.holdoutThrough);
  if (
    !input.source ||
    !input.strategyVersion ||
    !Number.isFinite(start) ||
    !(end > start) ||
    !Array.isArray(input.cases)
  )
    throw new Error('Replay requires a source, frozen strategy version and ordered holdout dates');
  const seen = new Set<string>();
  const outcomes = input.cases.map((row) => {
    const decision = Date.parse(row.decisionAt),
      available = Date.parse(row.inputsAvailableAt);
    const s = row.signal;
    if (
      seen.has(row.id) ||
      row.strategyVersion !== input.strategyVersion ||
      !(decision > start && decision < end) ||
      !Number.isFinite(available) ||
      available > decision ||
      s.status !== 'PENDING' ||
      +new Date(s.createdAt) !== decision ||
      s.filledAt ||
      s.target1At ||
      s.closedAt ||
      s.checkedThrough
    )
      throw new Error(`Invalid or look-ahead replay record: ${row.id}`);
    if (
      ![
        s.entry,
        s.entryLow,
        s.entryHigh,
        s.stopLoss,
        s.target1,
        s.target2,
        s.costBps,
        s.slippageBps
      ].every(Number.isFinite) ||
      !(
        s.stopLoss > 0 &&
        s.stopLoss < s.entryLow &&
        s.entryLow <= s.entry &&
        s.entry <= s.entryHigh &&
        s.entryHigh < s.target1 &&
        s.target1 < s.target2
      ) ||
      s.costBps! < 0 ||
      s.slippageBps! < 0
    )
      throw new Error(`Invalid frozen price/cost inputs: ${row.id}`);
    if (!(
      +new Date(s.entryExpiresAt) > decision && +new Date(s.expiresAt) >= +new Date(s.entryExpiresAt)
    ))
      throw new Error(`Invalid frozen holding window: ${row.id}`);
    seen.add(row.id);
    const bars = row.bars.map((b) => ({ ...b, date: new Date(b.date) }));
    if (
      bars.some(
        (b, i) => !Number.isFinite(+b.date) || (i > 0 && +b.date <= +bars[i - 1].date) || b.splitReported
      )
    )
      throw new Error(`Replay bar ordering or corporate-action consistency requires review: ${row.id}`);
    const outcome = {
      ...evaluatePaperSignal(s, bars, new Date(end)),
      evaluationVersion: PAPER_EVALUATION_VERSION
    };
    return { id: row.id, symbol: row.symbol, outcome };
  });
  return {
    source: input.source,
    strategyVersion: input.strategyVersion,
    tuneThrough: input.tuneThrough,
    holdoutThrough: input.holdoutThrough,
    submitted: outcomes.length,
    stats: summarizePaperSignals(outcomes.map((x) => x.outcome)),
    outcomes
  };
}

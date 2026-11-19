import type { ScreenedStock, ScreenerMode } from './screenerEngine';
import {
  entryExpiry,
  rewardRiskEntryCeiling,
  STRATEGY_POLICIES,
  STRATEGY_VERSION,
  tradeCosts
} from './strategyPolicy';
import { dateToISTString } from './timezone';
export interface NumericTradePlan {
  entryLow: number;
  entryHigh: number;
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  riskRewardRatio: number;
  holdingPeriod: string;
  policyVersion: string;
  trigger: string;
  invalidation: string;
  chaseLimit: number;
  validUntil: string;
  tickSize: number | null;
  netRiskReward: number;
  minimumNetRR: number;
  estimatedCostBps: number;
  estimatedSlippageBps: number;
  accepted: boolean;
  reasons: string[];
}
export const HOLDING_PERIODS: Record<ScreenerMode, string> = {
  intraday: 'Same session',
  btst: 'Next trading session',
  swing_breakout: '2–4 weeks',
  swing_pullback: '2–4 weeks',
  positional: '1–3 months',
  longterm: 'Research horizon: 1–5 years'
};
const money = (n: number) => Math.round(n * 100) / 100;
export function getTradePlan(
  stock: Pick<ScreenedStock, 'cmp' | 'atr' | 'defaultSL' | 'target1' | 'target2' | 'mode'> &
    Partial<ScreenedStock>
): NumericTradePlan | null {
  if (stock.mode === 'longterm') return null;
  const { cmp, atr, defaultSL, target1, target2 } = stock;
  if (
    ![cmp, atr, defaultSL, target1, target2].every(Number.isFinite) ||
    cmp <= 0 ||
    atr <= 0 ||
    defaultSL <= 0 ||
    defaultSL >= cmp ||
    target1 <= cmp ||
    target2 < target1
  )
    return null;
  const tick =
    stock.tickSize &&
    stock.tickSize > 0 &&
    stock.tickSizeAsOf?.slice(0, 10) === dateToISTString(new Date())
      ? stock.tickSize
      : null;
  const round = (price: number, up: boolean) =>
    tick
      ? money((up ? Math.ceil(price / tick - 1e-8) : Math.floor(price / tick + 1e-8)) * tick)
      : money(price);
  const setupLow =
    stock.mode === 'swing_breakout' && stock.breakoutLevel != null
      ? stock.breakoutLevel
      : Math.max(cmp - atr * 0.5, stock.mode === 'intraday' ? (stock.breakoutLevel ?? 0) : 0);
  const setupHigh =
    stock.mode === 'swing_breakout' && stock.breakoutLevel != null
      ? stock.breakoutLevel + atr
      : ['swing_pullback', 'positional'].includes(stock.mode)
        ? cmp
        : cmp + atr * 0.5;
  const low = round(Math.max(defaultSL + (tick ?? 0.01), setupLow), true),
    proposedHigh = round(Math.min(target1 - (tick ?? 0.01), setupHigh), false);
  const stop = round(defaultSL, false),
    t1 = round(target1, false),
    t2 = round(target2, false);
  if (low > proposedHigh || stop >= low || proposedHigh >= t1 || t2 < t1) return null;
  const estimatedCostBps = stock.estimatedCostBps ?? 20;
  const estimatedSlippageBps = stock.estimatedSlippageBps ?? 5;
  const quoteAt = stock.dataQuality?.quoteAt ?? undefined;
  const referenceDay = dateToISTString(quoteAt ? new Date(quoteAt) : new Date());
  const eligibility = stock.dataQuality?.sessionEligibility;
  const cas = eligibility?.day === referenceDay ? eligibility.casEligible
    : stock.tickSizeAsOf === referenceDay ? stock.casEligible ?? null : null;
  const policy = STRATEGY_POLICIES[stock.mode];
  const increment = tick ?? 0.01;
  const ceiling = rewardRiskEntryCeiling(
    stop,
    t1,
    policy.minNetRR,
    estimatedCostBps,
    estimatedSlippageBps
  );
  const safeHigh = Math.min(proposedHigh, money(Math.floor(ceiling / increment + 1e-9) * increment));
  const hasSafeZone = safeHigh >= low;
  const high = hasSafeZone ? safeHigh : proposedHigh;
  const cost = tradeCosts(high, stop, t1, estimatedCostBps, estimatedSlippageBps);
  const reasons: string[] = [];
  if (!hasSafeZone || cost.netRR + 1e-8 < policy.minNetRR) {
    reasons.push(
      `No entry inside the technical zone meets ${policy.minNetRR.toFixed(2)}R after modeled costs`
    );
  } else if (money(cmp) > high) {
    reasons.push(
      `Price is above the cost-adjusted entry ceiling ₹${high.toFixed(2)}. Wait for a valid entry.`
    );
  }
  return {
    entryLow: low,
    entryHigh: high,
    entry: Math.min(high, Math.max(low, round(cmp, true))),
    stopLoss: stop,
    target1: t1,
    target2: t2,
    riskRewardRatio: (t1 - high) / (high - stop),
    holdingPeriod: HOLDING_PERIODS[stock.mode],
    policyVersion: STRATEGY_VERSION,
    trigger: policy.trigger,
    invalidation: `Invalid below ₹${stop.toFixed(2)}; skip above ₹${high.toFixed(2)}. A gap can exceed planned loss.`,
    chaseLimit: high,
    validUntil: entryExpiry(
      stock.mode,
      quoteAt,
      undefined,
      cas
    ),
    tickSize: tick,
    netRiskReward: cost.netRR,
    minimumNetRR: policy.minNetRR,
    estimatedCostBps,
    estimatedSlippageBps,
    accepted: !reasons.length,
    reasons
  };
}
export function positionSize(plan: NumericTradePlan | null, capital: number, riskPercent: number) {
  if (
    !plan ||
    !Number.isFinite(capital) ||
    capital <= 0 ||
    !Number.isFinite(riskPercent) ||
    riskPercent <= 0
  )
    return { quantity: 0, capitalRequired: 0, stopRisk: 0 };
  const costs = tradeCosts(
    plan.entryHigh,
    plan.stopLoss,
    plan.target1,
    plan.estimatedCostBps,
    plan.estimatedSlippageBps
  );
  const risk = costs.risk;
  if (!(risk > 0)) return { quantity: 0, capitalRequired: 0, stopRisk: 0 };
  const quantity = Math.max(
    0,
    Math.min(
      Math.floor(capital / costs.cashPerShare),
      Math.floor((capital * Math.min(riskPercent, 1)) / 100 / risk)
    )
  );
  return {
    quantity,
    capitalRequired: money(quantity * costs.cashPerShare),
    stopRisk: money(quantity * risk)
  };
}
export function formatTradeSetup(symbol: string, plan: NumericTradePlan, quantity: number): string {
  return `${symbol.replace('.NS', '')} | Entry: ₹${plan.entryLow.toFixed(2)}–₹${plan.entryHigh.toFixed(2)} | SL: ₹${plan.stopLoss.toFixed(2)} | T1: ₹${plan.target1.toFixed(2)} | T2: ₹${plan.target2.toFixed(2)} | Qty: ${quantity}`;
}

import type { ScreenerMode } from './screenerEngine';
import type { NumericTradePlan } from './tradePlan';
import { tradeCosts } from './strategyPolicy';
import { calendarDay, dateToISTString, latestCompletedSession, sessionTime } from './timezone';
export interface RiskPolicy {
  perTradePercent: number;
  totalRiskPercent: number;
  sectorPercent: number;
  maxPositions: number;
  dailyLossPercent: number;
}
export interface Position {
  id: string;
  symbol: string;
  sector: string;
  mode: ScreenerMode;
  quantity: number;
  averagePrice: number;
  initialStop: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  openedAt: string;
  lastFillAt: string;
  firstTargetFilledAt?: string;
  mark: number | null;
  markAt: string | null;
  stopHistory: Array<{ at: string; from: number | null; to: number; reason: string }>;
}
export interface Reservation {
  id: string;
  symbol: string;
  sector: string;
  quantity: number;
  cash: number;
  risk: number;
  createdAt: string;
}
export interface PortfolioEvent {
  id: string;
  type: string;
  at: string;
  symbol?: string;
  quantity?: number;
  price?: number;
  realized?: number;
  cashFlow?: number;
  note: string;
  signature: string;
}
export interface Portfolio {
  _id: 'owner';
  version: number;
  configured: boolean;
  cash: number;
  policy: RiskPolicy;
  positions: Position[];
  reservations: Reservation[];
  events: PortfolioEvent[];
  reconciledAt: string | null;
}
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  perTradePercent: 0.5,
  totalRiskPercent: 2,
  sectorPercent: 25,
  maxPositions: 8,
  dailyLossPercent: 2
};
export function emptyPortfolio(): Portfolio {
  return {
    _id: 'owner',
    version: 0,
    configured: false,
    cash: 0,
    policy: { ...DEFAULT_RISK_POLICY },
    positions: [],
    reservations: [],
    events: [],
    reconciledAt: null
  };
}

export function holdingQuantityDifferences(
  broker: ReadonlyArray<Pick<Position,'symbol'|'quantity'>>,
  journal: ReadonlyArray<Pick<Position,'symbol'|'quantity'>>
) {
  const totals = new Map<string,{ symbol:string; broker:number; journal:number }>();
  for (const [name, holdings] of [['broker',broker],['journal',journal]] as const) {
    for (const holding of holdings) {
      const value = totals.get(holding.symbol) ?? { symbol:holding.symbol, broker:0, journal:0 };
      value[name] += holding.quantity;
      totals.set(holding.symbol,value);
    }
  }
  return [...totals.values()].filter(item=>item.broker!==item.journal).sort((a,b)=>a.symbol.localeCompare(b.symbol));
}
function finite(n: unknown, low: number, high = 1e12): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= low && n <= high;
}
function fail(message: string): never {
  throw new Error(message);
}

export interface PortfolioPriorCloses {
  session: string;
  prices: Record<string, number>;
  issue?: string;
}

const MARK_MAX_AGE = 20 * 60_000;
function hasCurrentMark(position: Position, now: Date) {
  const at = Date.parse(position.markAt ?? '');
  return finite(position.mark, 0.01) && at <= +now && +now - at <= MARK_MAX_AGE &&
    dateToISTString(new Date(at)) === dateToISTString(now);
}

// Legacy settings wrote this exact note when recording before/after cash.
// New events also store the signed change directly.
function recordedCashFlow(event: PortfolioEvent): number {
  if (event.cashFlow !== undefined) return event.cashFlow;
  const recorded = /^Manual cash reconciliation: (\S+) → (\S+); risk policy updated$/.exec(event.note);
  return recorded ? Number(recorded[2]) - Number(recorded[1]) : NaN;
}

export function portfolioSessionOpening(p: Portfolio, now = new Date()) {
  const session = dateToISTString(now);
  if (!calendarDay(session).trading) return { reason: 'No verified NSE cash session for daily equity sizing' };
  const dayStart = +sessionTime(session, 0);
  // The previous final close values carried shares. Counting journal activity
  // from midnight IST includes any recorded opening-auction fills.
  const priorSession = latestCompletedSession(new Date(dayStart));
  const shares = new Map<string, number>();
  for (const position of p.positions) {
    shares.set(position.symbol, (shares.get(position.symbol) ?? 0) + position.quantity);
  }
  let openingCash = p.cash, netCashFlow = 0;
  for (const event of p.events) {
    if (event.type !== 'settings' && event.type !== 'fill') continue;
    const at = Date.parse(event.at);
    if (at < dayStart) continue;
    if (!Number.isFinite(at) || at > +now) return { reason: 'Journal activity timestamp unverified for daily equity' };
    if (event.type === 'settings') {
      const flow = recordedCashFlow(event);
      if (!Number.isFinite(flow)) return { reason: 'Cash adjustments are unverified for daily equity' };
      openingCash -= flow;
      netCashFlow += flow;
      continue;
    }
    let fill: Partial<Extract<PortfolioAction, {type:'fill'}>>;
    try { fill = JSON.parse(event.signature); }
    catch { return { reason: 'Recorded fill details are unavailable for daily equity' }; }
    if (fill?.type !== 'fill' || (fill.side !== 'BUY' && fill.side !== 'SELL') ||
        fill.symbol !== event.symbol || fill.quantity !== event.quantity || fill.price !== event.price ||
        Date.parse(fill.at ?? '') !== at || !fill.symbol || !finite(fill.quantity, 1) ||
        !Number.isSafeInteger(fill.quantity) || !finite(fill.price, 0.01) || !finite(fill.fees, 0)) {
      return { reason: 'Recorded fill details are unverified for daily equity' };
    }
    const direction = fill.side === 'BUY' ? 1 : -1;
    shares.set(fill.symbol, (shares.get(fill.symbol) ?? 0) - direction * fill.quantity);
    openingCash += direction * fill.quantity * fill.price + fill.fees;
  }
  if (!Number.isFinite(openingCash) || openingCash < -0.000001 ||
      [...shares.values()].some(quantity => !Number.isSafeInteger(quantity) || quantity < 0)) {
    return { reason: 'Opening cash or share quantities cannot be reconciled from the journal' };
  }
  const carried = [...shares].filter(([, quantity]) => quantity > 0);
  // Initial account funding establishes opening capital on the first day.
  // Later deposits and withdrawals stay out of both P&L and the loss budget.
  const first = p.events.find(event => event.type === 'settings' || event.type === 'fill');
  const initialFunding = first?.type === 'settings' && Date.parse(first.at) >= dayStart &&
    Math.abs(openingCash) <= 0.000001 && !carried.length ? Math.max(0, recordedCashFlow(first)) : 0;
  return { session, priorSession, carried, cash: Math.max(0, openingCash) + initialFunding, netCashFlow: netCashFlow - initialFunding };
}

function dailyEquity(p: Portfolio, equity: number, staleMarks: number, now: Date, priorCloses?: PortfolioPriorCloses | null) {
  const opening = portfolioSessionOpening(p, now);
  const missing = (reason: string) => ({
    session: dateToISTString(now), openingEquity: null, netCashFlow: null, pnl: null, percent: null, reason
  });
  if (!opening.carried) return missing(opening.reason);
  if (staleMarks) return missing('Current holding marks are unavailable for daily equity');
  let openingEquity = opening.cash;
  if (opening.carried.length && (!opening.priorSession || priorCloses?.session !== opening.priorSession)) {
    return missing('Previous NSE session closes are unavailable for overnight holdings');
  }
  if (opening.carried.length && priorCloses?.issue) return missing(priorCloses.issue);
  for (const [symbol, quantity] of opening.carried) {
    const close = priorCloses?.prices[symbol];
    if (!finite(close, 0.01)) return missing(`Previous NSE session close unavailable for ${symbol}`);
    openingEquity += quantity * close;
  }
  if (!(openingEquity > 0) || !Number.isFinite(openingEquity) || !Number.isFinite(equity)) {
    return missing('Positive opening equity is unavailable for daily sizing');
  }
  const pnl = equity - openingEquity - opening.netCashFlow;
  return {
    session: opening.session, openingEquity, netCashFlow: opening.netCashFlow, pnl,
    percent: 100 * pnl / openingEquity, reason: null
  };
}

export function portfolioTotals(p: Portfolio, now = new Date(), priorCloses?: PortfolioPriorCloses | null) {
  const marked = p.positions.reduce((n, x) => n + x.quantity * (x.mark ?? x.averagePrice), 0),
    equity = p.cash + marked;
  const reservedCash = p.reservations.reduce((n, x) => n + x.cash, 0),
    reservedRisk = p.reservations.reduce((n, x) => n + x.risk, 0);
  const openRisk = p.positions.reduce(
    (n, x) =>
      n +
      x.quantity *
        (x.stop == null
          ? x.averagePrice
          : Math.max(0, (x.mark ?? x.averagePrice) - x.stop) + x.averagePrice * 0.003),
    0
  );
  const today = dateToISTString(now),
    realizedToday = p.events
      .filter((x) => dateToISTString(new Date(x.at)) === today)
      .reduce((n, x) => n + (x.realized ?? 0), 0);
  const unrealized = p.positions.reduce(
    (n, x) => n + x.quantity * ((x.mark ?? x.averagePrice) - x.averagePrice),
    0
  );
  const staleMarks = p.positions.filter(x => !hasCurrentMark(x, now)).length;
  return {
    equity,
    availableCash: Math.max(0, p.cash - reservedCash),
    reservedCash,
    reservedRisk,
    openRisk,
    realizedToday,
    unrealized,
    dailyEquity: dailyEquity(p, equity, staleMarks, now, priorCloses),
    unknownStops: p.positions.filter((x) => x.stop == null).length,
    staleMarks
  };
}
export function portfolioSizing(
  p: Portfolio,
  plan: NumericTradePlan | null,
  sector: string,
  symbol: string,
  regimeRiskPercent: number,
  now = new Date(),
  priorCloses?: PortfolioPriorCloses | null
) {
  const totals = portfolioTotals(p, now, priorCloses),
    reasons: string[] = [];
  if (!p.configured) reasons.push('Configure cash and risk limits first');
  if (!p.reconciledAt || dateToISTString(new Date(p.reconciledAt)) !== dateToISTString(now))
    reasons.push('Review actual holdings, cash and pending orders today');
  if (totals.unknownStops) reasons.push('An open holding has no defined stop');
  if (totals.staleMarks) reasons.push('Open-position prices require a current update');
  if (sector === 'Unknown' || !sector) reasons.push('Sector classification unavailable');
  if (p.positions.length + p.reservations.length >= p.policy.maxPositions)
    reasons.push('Position/pending-order limit reached');
  if (p.positions.some((x) => x.symbol === symbol) || p.reservations.some((x) => x.symbol === symbol))
    reasons.push('Existing position or pending entry in this symbol');
  const daily = totals.dailyEquity;
  if (!finite(p.policy.dailyLossPercent, 0.1, 10)) reasons.push('Set a valid positive daily equity loss limit');
  else if (daily.reason) reasons.push(daily.reason);
  else if (daily.pnl !== null && daily.openingEquity !== null &&
      daily.pnl <= -(daily.openingEquity * p.policy.dailyLossPercent) / 100 + 0.000001) {
    reasons.push('Daily equity loss limit reached');
  }
  if (!plan || !plan.accepted) reasons.push('Trade-plan policy does not clear a new entry');
  if (plan && Date.parse(plan.validUntil) <= +now) reasons.push('Entry plan expired');
  if (plan && !plan.tickSize) reasons.push('Current instrument tick size is unavailable');
  if (!finite(regimeRiskPercent, 0.000001, 100)) reasons.push('Current setup/regime clears zero risk');
  const sectorUsed =
    p.positions
      .filter((x) => x.sector === sector)
      .reduce((n, x) => n + x.quantity * (x.mark ?? x.averagePrice), 0) +
    p.reservations.filter((x) => x.sector === sector).reduce((n, x) => n + x.cash, 0);
  const portfolioRoom = Math.max(
    0,
    (totals.equity * p.policy.totalRiskPercent) / 100 - totals.openRisk - totals.reservedRisk
  );
  const riskBudget = Math.min(
    (totals.equity * Math.min(p.policy.perTradePercent, regimeRiskPercent)) / 100,
    portfolioRoom
  );
  const sectorRoom = Math.max(0, (totals.equity * p.policy.sectorPercent) / 100 - sectorUsed);
  const costs = plan
    ? tradeCosts(
        plan.entryHigh,
        plan.stopLoss,
        plan.target1,
        plan.estimatedCostBps,
        plan.estimatedSlippageBps
      )
    : null;
  const quantity =
    reasons.length || !costs
      ? 0
      : Math.max(
          0,
          Math.floor(
            Math.min(
              totals.availableCash / costs.cashPerShare,
              sectorRoom / costs.cashPerShare,
              riskBudget / costs.risk
            )
          )
        );
  if (!reasons.length && !quantity) reasons.push('Cash, sector or aggregate risk budget exhausted');
  return {
    quantity,
    cashRequired: quantity * (costs?.cashPerShare ?? 0),
    plannedRisk: quantity * (costs?.risk ?? 0),
    reasons,
    totals
  };
}
export type PortfolioAction =
  | { id: string; type: 'settings'; cash: number; policy: RiskPolicy }
  | { id: string; type: 'reconcile' }
  | {
      id: string;
      type: 'fill';
      side: 'BUY' | 'SELL';
      symbol: string;
      sector: string;
      mode: ScreenerMode;
      quantity: number;
      price: number;
      fees: number;
      at: string;
      stop?: number;
      target1?: number;
      target2?: number;
      reservationId?: string;
    }
  | { id: string; type: 'stop'; positionId: string; stop: number; reason: string }
  | { id: string; type: 'mark'; positionId: string; price: number; at: string }
  | { id: string; type: 'reserve'; reservation: Reservation }
  | { id: string; type: 'cancel'; reservationId: string };
export function applyPortfolioAction(
  original: Portfolio,
  action: PortfolioAction,
  now = new Date()
): Portfolio {
  if (!/^[\w-]{8,100}$/.test(action.id)) fail('A unique request id is required');
  const signature = JSON.stringify(action),
    existing = original.events.find((x) => x.id === action.id);
  if (existing) {
    if (existing.signature !== signature) fail('Request id already used for different data');
    return original;
  }
  if (original.events.length >= 1000)
    fail('Journal capacity reached; export and archive before adding records');
  const p = structuredClone(original),
    event: PortfolioEvent = {
      id: action.id,
      type: action.type,
      at: now.toISOString(),
      note: '',
      signature
    };
  switch (action.type) {
    case 'settings': {
      if (!finite(action.cash, 0) || !action.policy) fail('Valid cash and risk policy required');
      const v = action.policy;
      if (
        !finite(v.perTradePercent, 0.1, 2) ||
        !finite(v.totalRiskPercent, v.perTradePercent, 10) ||
        !finite(v.sectorPercent, 1, 100) ||
        !Number.isInteger(v.maxPositions) ||
        v.maxPositions < 1 ||
        v.maxPositions > 30 ||
        !finite(v.dailyLossPercent, 0.1, 10)
      )
        fail('Risk policy is outside supported bounds');
      if (action.cash < p.reservations.reduce((n, r) => n + r.cash, 0))
        fail('Cash cannot be below reserved cash');
      event.cashFlow = action.cash - p.cash;
      event.note = `Manual cash reconciliation: ${p.cash} → ${action.cash}; risk policy updated`;
      p.cash = action.cash;
      p.policy = { ...v };
      p.configured = true;
      p.reconciledAt = null;
      break;
    }
    case 'reconcile':
      p.reconciledAt = now.toISOString();
      event.note = 'Owner reviewed holdings, cash and pending orders';
      break;
    case 'fill': {
      if (
        !/^[A-Z0-9&-]{1,25}\.NS$/.test(action.symbol) ||
        !['intraday', 'btst', 'swing_breakout', 'swing_pullback', 'positional', 'longterm'].includes(
          action.mode
        ) ||
        !['BUY', 'SELL'].includes(action.side) ||
        !Number.isInteger(action.quantity) ||
        !finite(action.quantity, 1, 1e6) ||
        !finite(action.price, 0.01) ||
        !finite(action.fees, 0) ||
        !Number.isFinite(Date.parse(action.at)) ||
        Date.parse(action.at) > +now + 60000
      )
        fail('Invalid recorded fill');
      if (!p.configured) fail('Configure cash before recording fills');
      let position = p.positions.find((x) => x.symbol === action.symbol && x.mode === action.mode);
      if (position && Date.parse(action.at) < Date.parse(position.lastFillAt))
        fail('Record fills for this position in chronological order');
      if (action.stop != null && (!finite(action.stop, 0.01) || action.stop >= action.price))
        fail('Initial stop must be below the buy price');
      if (
        action.target1 != null &&
        (!finite(action.target1, action.price) || action.target1 === action.price)
      )
        fail('First target must be above entry');
      if (
        action.target2 != null &&
        (action.target1 == null ||
          !finite(action.target2, action.target1) ||
          action.target2 === action.target1)
      )
        fail('Second target must be above the first target');
      const reservation = p.reservations.find((r) => r.id === action.reservationId);
      if (
        action.reservationId &&
        (!reservation || reservation.symbol !== action.symbol || action.quantity > reservation.quantity)
      )
        fail('Fill does not match the pending reservation');
      if (action.side === 'BUY') {
        const used = action.quantity * action.price + action.fees;
        const otherReserved = p.reservations
          .filter((r) => r.id !== action.reservationId)
          .reduce((n, r) => n + r.cash, 0);
        if (used > p.cash - otherReserved)
          fail('Insufficient unreserved cash; reconcile actual available funds first');
        if (!position) {
          position = {
            id: action.id,
            symbol: action.symbol,
            sector: action.sector || 'Unknown',
            mode: action.mode,
            quantity: 0,
            averagePrice: 0,
            initialStop: action.stop ?? null,
            stop: action.stop ?? null,
            target1: finite(action.target1, action.price) ? action.target1 : null,
            target2: finite(action.target2, action.price) ? action.target2 : null,
            openedAt: action.at,
            lastFillAt: action.at,
            mark: action.price,
            markAt: action.at,
            stopHistory: []
          };
          p.positions.push(position);
        }
        position.averagePrice =
          (position.averagePrice * position.quantity + used) / (position.quantity + action.quantity);
        position.quantity += action.quantity;
        p.cash -= used;
      } else {
        if (!position || position.quantity < action.quantity) fail('Sell exceeds the recorded holding');
        if (reservation) fail('An entry reservation can only be matched to a buy fill');
        if (action.fees > action.quantity * action.price) fail('Fees exceed gross sale proceeds');
        p.cash += action.quantity * action.price - action.fees;
        event.realized = action.quantity * (action.price - position.averagePrice) - action.fees;
        position.quantity -= action.quantity;
        if (position.quantity > 0 && position.target1 != null && action.price >= position.target1)
          position.firstTargetFilledAt ??= action.at;
      }
      if (position) {
        position.lastFillAt = action.at;
        if (!position.markAt || Date.parse(action.at) >= Date.parse(position.markAt)) {
          position.mark = action.price;
          position.markAt = action.at;
        }
      }
      if (reservation) {
        const fraction = action.quantity / reservation.quantity;
        reservation.cash *= 1 - fraction;
        reservation.risk *= 1 - fraction;
        reservation.quantity -= action.quantity;
        p.reservations = p.reservations.filter((r) => r.quantity > 0);
      }
      p.positions = p.positions.filter((x) => x.quantity > 0);
      event.at = action.at;
      event.symbol = action.symbol;
      event.quantity = action.quantity;
      event.price = action.price;
      event.note = `Recorded ${action.side}; fees ₹${action.fees}. No broker order sent`;
      break;
    }
    case 'stop': {
      const position = p.positions.find((x) => x.id === action.positionId);
      if (
        !position ||
        !finite(action.stop, 0.01) ||
        typeof action.reason !== 'string' ||
        action.reason.trim().length < 5 ||
        action.reason.length > 300
      )
        fail('Position, stop and a reason are required');
      if (position.stop != null && action.stop < position.stop)
        fail('Stop widening is blocked; preserve the initial risk boundary');
      if (position.mark == null || !position.markAt || +now - Date.parse(position.markAt) > 20 * 60000)
        fail('Update the observed price before revising the stop');
      if (action.stop >= position.mark) fail('Revised stop must be below the latest observed price');
      if (position.initialStop == null) position.initialStop = action.stop;
      position.stopHistory.push({
        at: now.toISOString(),
        from: position.stop,
        to: action.stop,
        reason: action.reason.trim()
      });
      position.stop = action.stop;
      event.symbol = position.symbol;
      event.note = action.reason.trim();
      break;
    }
    case 'mark': {
      const position = p.positions.find((x) => x.id === action.positionId);
      if (
        !position ||
        !finite(action.price, 0.01) ||
        !Number.isFinite(Date.parse(action.at)) ||
        Date.parse(action.at) > +now + 60000 ||
        +now - Date.parse(action.at) > 20 * 60000
      )
        fail('A current observed price and timestamp are required');
      if (position.markAt && Date.parse(action.at) < Date.parse(position.markAt))
        fail('Observed price is older than the recorded price');
      position.mark = action.price;
      position.markAt = action.at;
      event.note = 'Owner-recorded price; not a verified exchange feed';
      break;
    }
    case 'reserve': {
      const r = action.reservation;
      if (
        !r ||
        !Number.isInteger(r.quantity) ||
        !finite(r.quantity, 1) ||
        !finite(r.cash, 0.01) ||
        !finite(r.risk, 0.01) ||
        p.reservations.some((x) => x.id === r.id)
      )
        fail('Invalid reservation');
      if (r.cash > p.cash - p.reservations.reduce((sum, item) => sum + item.cash, 0)) fail('Insufficient cash for reservation');
      p.reservations.push(r);
      event.note = `Manual pending-entry reservation for ${r.symbol}; not a broker order`;
      break;
    }
    case 'cancel':
      if (!p.reservations.some((r) => r.id === action.reservationId)) fail('Reservation not found');
      p.reservations = p.reservations.filter((r) => r.id !== action.reservationId);
      event.note = 'Manual reservation released; broker order status must be reconciled separately';
      break;
    default:
      fail('Unknown portfolio action');
  }
  p.events.push(event);
  p.version++;
  return p;
}
export function positionReview(position: Position, now = new Date()) {
  const actions: string[] = [];
  if (position.stop == null) actions.push('Define an invalidation stop; new portfolio risk is blocked');
  if (!position.markAt || +now - Date.parse(position.markAt) > 20 * 60000)
    return [
      'Current price unavailable; refresh the observed price before evaluating exit triggers',
      ...actions
    ];
  if (position.stop != null && position.mark! <= position.stop)
    actions.push(
      'Observed price is at/below the recorded stop; review exit immediately with the broker'
    );
  if (position.target2 != null && position.mark! >= position.target2)
    actions.push('Observed price reached T2; review the remaining-position exit');
  else if (
    position.target1 != null &&
    position.mark! >= position.target1 &&
    !position.firstTargetFilledAt
  )
    actions.push(
      'Observed price reached T1; review the planned partial exit and record the actual fill'
    );
  if (position.firstTargetFilledAt && position.target2 != null && position.mark! < position.target2)
    actions.push('Partial exit recorded. Review remaining shares against the current stop and T2.');
  const maxDays = {
    intraday: 1,
    btst: 4,
    swing_breakout: 28,
    swing_pullback: 28,
    positional: 90,
    longterm: 365
  }[position.mode];
  if (+now - Date.parse(position.openedAt) > maxDays * 86400000)
    actions.push('Research holding horizon expired; reassess the thesis and time exit');
  return actions.length
    ? actions
    : ['No recorded stop/target trigger at the last observed price; continue monitoring'];
}

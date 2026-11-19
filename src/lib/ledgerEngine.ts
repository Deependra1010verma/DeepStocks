import type { OHLCV } from './indicators';
import type { ScreenerMode } from './screenerEngine';
import { calendarDay, dateToISTString, nextMarketOpen, cashSessionLimits, shiftDate, isContinuous15mBar, sessionTime } from './timezone';
import { entryExpiry } from './strategyPolicy';
export type PaperStatus = 'PENDING'|'OPEN'|'TARGET1'|'TARGET2'|'STOP_LOSS'|'EXPIRED'|'AMBIGUOUS'|'UNRESOLVED';
export const PAPER_EVALUATION_VERSION = 6;
const BAR_MS = 15 * 60_000;
export interface PaperSignal {
  status: PaperStatus; entryLow: number; entryHigh: number; entry: number;
  stopLoss: number; target1: number; target2: number; createdAt: Date|string;
  entryExpiresAt: Date|string; expiresAt: Date|string; filledAt?: Date|string;
  closedAt?: Date|string; checkedThrough?: Date|string; exitPrice?: number;
  target1At?: Date|string; target1Price?: number; realizedR?: number; outcomeReason?: string;
  costBps?: number; slippageBps?: number;
}
export function signalExpiry(mode: ScreenerMode, now: Date, casEligible: boolean|null = null): { entryExpiresAt: Date; expiresAt: Date } {
  const entryExpiresAt = new Date(entryExpiry(mode,now.toISOString(),now,casEligible));
  if (mode==='intraday') return {entryExpiresAt,expiresAt:entryExpiresAt};
  if(mode==='btst'){
    const exitDate=dateToISTString(nextMarketOpen(entryExpiresAt));
    if (!calendarDay(exitDate).trading) return {entryExpiresAt, expiresAt:entryExpiresAt};
    return {entryExpiresAt,expiresAt:sessionTime(exitDate, cashSessionLimits(exitDate).continuousEnd)};
  }
  const holding = {swing_breakout:28,swing_pullback:28,positional:90,longterm:365}[mode];
  return {entryExpiresAt,expiresAt:new Date(+now+holding*86400000)};
}

function hasUnverifiedGap(from: number, until: number, eligibility?: ReadonlyMap<string, boolean>): boolean {
  if (from >= until) return from > until;

  const lastDay = dateToISTString(new Date(until));
  for (let day = dateToISTString(new Date(from)); day <= lastDay; day = shiftDate(day, 1)) {
    const session = calendarDay(day);
    if (!session.verified) return true;
    if (!session.trading) continue;
    const limits = cashSessionLimits(day, eligibility?.get(day) ?? false);
    const open = +sessionTime(day, limits.continuousStart);
    // Until historical CAS eligibility is available, require coverage through
    // the latest possible continuous close before crossing a session boundary.
    const close = +sessionTime(day, limits.continuousEnd);
    const first = open + Math.max(0, Math.ceil((from - open) / BAR_MS)) * BAR_MS;
    if (Math.max(first, open) < Math.min(until, close)) return true;
  }
  return false;
}

export function evaluatePaperSignal(
  signal: PaperSignal, candles: OHLCV[], now = new Date(), eligibility?: ReadonlyMap<string, boolean>,
  priceBasisActionDays: readonly string[] | null = []
): PaperSignal {
  const next = {...signal};
  if (!['PENDING','OPEN','TARGET1'].includes(next.status)) return next;
  const start = new Date(next.checkedThrough ?? next.createdAt).getTime();
  const expires = +new Date(next.expiresAt);
  const entryExpires = Math.min(+new Date(next.entryExpiresAt), expires);
  const created = +new Date(next.createdAt);
  if (![start, expires, entryExpires, created].every(Number.isFinite)) {
    return { ...next, status: 'UNRESOLVED', closedAt: now, exitPrice: undefined, realizedR: undefined,
      outcomeReason: 'Missing or invalid price-path timestamps' };
  }
  const bars = candles.filter(c=>+new Date(c.date)>=start && +new Date(c.date)+BAR_MS<=+now).sort((a,b)=>+new Date(a.date)-+new Date(b.date));
  let cursor = start;
  const slippage = Math.max(0,next.slippageBps??5)/10000;
  const close = (status: PaperStatus, price: number | undefined, at: Date|string, reason: string) => {
    next.status=status;next.exitPrice=price;next.closedAt=at;next.outcomeReason=reason;
    next.realizedR = undefined;
    if (status==='AMBIGUOUS'||status==='UNRESOLVED'||!next.filledAt||price===undefined) return;
    const risk=next.entry-next.stopLoss;
    const firstExit = next.target1Price ?? next.target1 * (1 - slippage);
    const gross=next.target1At ? 0.5*(firstExit-next.entry)+0.5*(price-next.entry) : price-next.entry;
    next.realizedR=risk>0?(gross-next.entry*Math.max(0,next.costBps??20)/10000)/risk:undefined;
  };
  // A provider can restate earlier candles after an action. Check the full
  // fetched window before interpreting any price against frozen levels.
  const from = dateToISTString(new Date(created)), through = dateToISTString(now);
  const affected = (day: string) => day >= from && day <= through;
  if (candles.some(bar => bar.splitReported && +new Date(bar.date) <= +now &&
        affected(dateToISTString(new Date(bar.date)))) || priceBasisActionDays?.some(affected)) {
    close('UNRESOLVED', undefined, now, 'Corporate action reported; frozen levels and candle adjustment basis require verification');
    return next;
  }
  if (priceBasisActionDays === null) {
    const deadline = next.status === 'PENDING' ? entryExpires : expires;
    if (+now > deadline + 4 * 86400000) close('UNRESOLVED', undefined, now, 'Historical NSE corporate-action coverage unavailable');
    else next.outcomeReason = 'Waiting for historical NSE corporate-action coverage';
    return next;
  }
  if (next.outcomeReason === 'Waiting for historical NSE corporate-action coverage') next.outcomeReason = undefined;
  for (const bar of bars) {
    const at=new Date(bar.date), end=new Date(+at+BAR_MS);
    const pending = next.status === 'PENDING';
    const deadline = pending ? entryExpires : expires;
    if (pending && +at >= deadline && !hasUnverifiedGap(cursor, deadline, eligibility)) {
      close('EXPIRED', undefined, new Date(deadline), 'Entry window expired without fill');
      break;
    }
    if (+end > deadline) {
      close('UNRESOLVED', undefined, new Date(deadline), 'No complete price path through expiry');
      break;
    }
    if (!isContinuous15mBar(at, eligibility?.get(dateToISTString(at)) ?? null) || hasUnverifiedGap(cursor, +at, eligibility)) {
      close('UNRESOLVED', undefined, at, 'Missing or misaligned price-path history');
      break;
    }
    if (![bar.open,bar.high,bar.low,bar.close].every(Number.isFinite) ||
        bar.low <= 0 || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
      close('UNRESOLVED', undefined, at, 'Invalid OHLC data');
      break;
    }
    cursor = +end;
    next.checkedThrough=end;
    let justFilled=false;
    if (next.status==='PENDING') {
      if (bar.open<next.stopLoss) {close('EXPIRED',bar.open,at,'Gap below invalidation before entry');break;}
      if (bar.low>next.entryHigh||bar.high<next.entryLow) {
        if (+end === entryExpires) close('EXPIRED', undefined, end, 'Entry window expired without fill');
        if (next.closedAt) break;
        continue;
      }
      const raw=bar.open>=next.entryLow&&bar.open<=next.entryHigh?bar.open:bar.open<next.entryLow?next.entryLow:next.entryHigh;
      next.entry=raw*(1+slippage);next.filledAt=at;next.status='OPEN';justFilled=raw!==bar.open;
    }
    if (next.status==='OPEN'||next.status==='TARGET1') {
      const hitStop=bar.low<=next.stopLoss,hitT1=bar.high>=next.target1,hitT2=bar.high>=next.target2;
      if (!justFilled && bar.open<=next.stopLoss) {close('STOP_LOSS',bar.open*(1-slippage),at,'Opening gap crossed stop before intrabar targets');break;}
      if(!justFilled&&bar.open>=next.target1&&!next.target1At){next.target1At=at;next.target1Price=next.target1*(1-slippage);next.status='TARGET1';}
      if(!justFilled&&bar.open>=next.target2){close('TARGET2',next.target2*(1-slippage),at,'Opening price crossed remaining target before intrabar stop');break;}
      const remainingTargetHit = next.target1At ? hitT2 : hitT1;
      if ((hitStop&&remainingTargetHit)||(justFilled&&(hitStop||hitT1))) {close('AMBIGUOUS',0,at,'Entry/SL/target order cannot be determined within the candle');break;}
      if (hitStop) {close('STOP_LOSS',Math.min(bar.open,next.stopLoss)*(1-slippage),at,'Stop crossed, including opening gap and assumed slippage');break;}
      if (hitT1&&!next.target1At) {next.target1At=at;next.target1Price=next.target1*(1-slippage);next.status='TARGET1';}
      if (hitT2) {close('TARGET2',next.target2*(1-slippage),at,'Second target reached; half position modeled at first target');break;}
      if (+end === expires) {close('EXPIRED',bar.close*(1-slippage),end,'Holding horizon expired; modeled exit at close');break;}
    }
  }
  if (!next.closedAt && +now > (next.status === 'PENDING' ? entryExpires : expires) + 4 * 86400000) {
    close('UNRESOLVED', undefined, now, 'No usable price-path history through expiry');
  }
  return next;
}
export function summarizePaperSignals(items: Array<PaperSignal & {evaluationVersion?: number}>) {
  const evaluated=items.filter(s=>s.evaluationVersion===PAPER_EVALUATION_VERSION);
  const closed=evaluated.filter(s=>s.closedAt&&s.filledAt&&typeof s.realizedR==='number'&&Number.isFinite(s.realizedR)&&!['AMBIGUOUS','UNRESOLVED'].includes(s.status));
  const wins=closed.filter(s=>s.realizedR!>0).length;
  const total=closed.reduce((sum,s)=>sum+s.realizedR!,0);
  const gains=closed.reduce((sum,s)=>sum+Math.max(0,s.realizedR!),0),losses=closed.reduce((sum,s)=>sum+Math.max(0,-s.realizedR!),0);
  let equity=0,peak=0,maxDrawdownR=0;
  for(const s of [...closed].sort((a,b)=>+new Date(a.closedAt!)-+new Date(b.closedAt!))){equity+=s.realizedR!;peak=Math.max(peak,equity);maxDrawdownR=Math.max(maxDrawdownR,peak-equity);}
  const n=closed.length,p=n?wins/n:0,z=1.96,den=1+z*z/Math.max(n,1),center=(p+z*z/(2*Math.max(n,1)))/den,margin=z*Math.sqrt(p*(1-p)/Math.max(n,1)+z*z/(4*Math.max(n,1)**2))/den;
  const sessionGroups=new Map<string,number>();
  for(const s of closed){const day=dateToISTString(new Date(s.filledAt!));sessionGroups.set(day,(sessionGroups.get(day)??0)+1);}
  return {closed:n,wins,winRate:n?p:null,expectancyR:n?total/n:null,profitFactor:losses?gains/losses:null,maxDrawdownR:n?maxDrawdownR:null,confidence95:n&&sessionGroups.size===n?[Math.max(0,center-margin),Math.min(1,center+margin)]:null,entrySessions:sessionGroups.size,largestSessionGroup:Math.max(0,...sessionGroups.values()),ambiguous:evaluated.filter(s=>['AMBIGUOUS','UNRESOLVED'].includes(s.status)).length,legacyExcluded:items.length-evaluated.length,method:'Paper simulation; 50% T1 / 50% T2; estimated costs/slippage. Same-session clustered outcomes suppress the naïve confidence interval.'};
}

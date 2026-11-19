import type { OHLCV } from './indicators';
import type { ScreenerMode } from './screenerEngine';
import { dateToISTString, nextMarketOpen, cashSessionLimits } from './timezone';
import { entryExpiry } from './strategyPolicy';
export type PaperStatus = 'PENDING'|'OPEN'|'TARGET1'|'TARGET2'|'STOP_LOSS'|'EXPIRED'|'AMBIGUOUS'|'UNRESOLVED';
export const PAPER_EVALUATION_VERSION = 3;
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
    const end=cashSessionLimits(exitDate,casEligible).continuousEnd;
    return {entryExpiresAt,expiresAt:new Date(+new Date(`${exitDate}T00:00:00+05:30`)+end*60_000)};
  }
  const holding = {swing_breakout:28,swing_pullback:28,positional:90,longterm:365}[mode];
  return {entryExpiresAt,expiresAt:new Date(+now+holding*86400000)};
}
export function evaluatePaperSignal(signal: PaperSignal, candles: OHLCV[], now = new Date()): PaperSignal {
  const next = {...signal};
  if (!['PENDING','OPEN','TARGET1'].includes(next.status)) return next;
  const start = new Date(next.checkedThrough ?? next.createdAt).getTime();
  const bars = candles.filter(c=>+new Date(c.date)>=start && +new Date(c.date)+900000<=+now).sort((a,b)=>+new Date(a.date)-+new Date(b.date));
  if (!bars.length) return +now > +new Date(next.expiresAt)+4*86400000 ? {...next,status:'UNRESOLVED',outcomeReason:'No usable price-path history after expiry; excluded from accuracy'} : next;
  // We cannot infer fills or outcomes through missing history.
  if (+new Date(bars[0].date)-start > 4*86400000) return {...next,status:'UNRESOLVED',outcomeReason:'Missing price-path history; excluded from accuracy'};
  const slippage = Math.max(0,next.slippageBps??5)/10000;
  const close = (status: PaperStatus, price: number, at: Date|string, reason: string) => {
    next.status=status;next.exitPrice=price;next.closedAt=at;next.outcomeReason=reason;
    if (status==='AMBIGUOUS'||status==='UNRESOLVED'||!next.filledAt) return;
    const risk=next.entry-next.stopLoss;
    const firstExit = next.target1Price ?? next.target1 * (1 - slippage);
    const gross=next.target1At ? 0.5*(firstExit-next.entry)+0.5*(price-next.entry) : price-next.entry;
    next.realizedR=risk>0?(gross-next.entry*Math.max(0,next.costBps??20)/10000)/risk:undefined;
  };
  for (const bar of bars) {
    const at=new Date(bar.date), end=new Date(+at+900000);
    if (![bar.open,bar.high,bar.low,bar.close].every(Number.isFinite)||bar.high<bar.low) {close('UNRESOLVED',0,at,'Invalid OHLC data');break;}
    next.checkedThrough=end;
    let justFilled=false;
    if (next.status==='PENDING') {
      if (+at>=+new Date(next.entryExpiresAt)) {close('EXPIRED',bar.open,at,'Entry window expired without fill');break;}
      if (bar.open<next.stopLoss) {close('EXPIRED',bar.open,at,'Gap below invalidation before entry');break;}
      if (bar.low>next.entryHigh||bar.high<next.entryLow) continue;
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
      if (+end>=+new Date(next.expiresAt)) {close('EXPIRED',bar.close*(1-slippage),at,'Holding horizon expired; modeled exit at close');break;}
    }
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

import { SignalLedger } from './models/SignalLedger';
import { getTradePlan } from './tradePlan';
import { signalExpiry, evaluatePaperSignal, PAPER_EVALUATION_VERSION, type PaperSignal } from './ledgerEngine';
import type { ScreenedStock } from './screenerEngine';
import { dateToISTString, shiftDate, todayIST } from './timezone';
import { AppError } from './operations';
import { fetchHistoricalCandleSeries } from './dataFetcher';
import { getNsePriceBasisActions } from './nseCorporateEvents';
import { beforeDeadline } from './deadline';
import { requiresOvernightClearance, STRATEGY_VERSION } from './strategyPolicy';
import { referenceEntryReasons } from './entryClearance';
export async function recordPaperSignal(stock: ScreenedStock) {
  const plan=getTradePlan(stock);
  if (!plan?.accepted||stock.nearMiss||!stock.dataQuality||stock.dataQuality.stale||Date.parse(plan.validUntil)<=Date.now()) throw new AppError('NOT_QUALIFIED','Only current qualified research setups can enter the paper ledger.',422);
  const now = new Date(), signalDate = todayIST();
  const reasons = referenceEntryReasons(stock, now);
  if (requiresOvernightClearance(stock.mode) && (stock.earningsRisk || stock.eventStatus !== 'known' || stock.eventConflict)) {
    reasons.push('Overnight event clearance unavailable');
  }
  if (reasons.length) throw new AppError('NOT_QUALIFIED', reasons.join('. '), 422);
  const eligibility = stock.dataQuality.sessionEligibility;
  const cas = eligibility?.day === signalDate ? eligibility.casEligible : null;
  const expiry = signalExpiry(stock.mode, now, cas);
  const query = { symbol:stock.symbol, mode:stock.mode, signalDate };
  return SignalLedger.findOneAndUpdate(query,{$setOnInsert:{...query,evaluationVersion:PAPER_EVALUATION_VERSION,strategyVersion:STRATEGY_VERSION,decisionAt:now,quoteAt:stock.dataQuality.quoteAt,...(cas === null ? {} : {casEligibleAtSignal:cas}),entry:plan.entry,entryLow:plan.entryLow,entryHigh:plan.entryHigh,stopLoss:plan.stopLoss,target1:plan.target1,target2:plan.target2,quantScore:stock.quantScore,rvolAtEntry:stock.relativeVolume?.value,rsiAtEntry:stock.rsi,sector:stock.sector,regime:stock.regime,riskPercent:stock.positionRiskPercent,status:'PENDING',createdAt:now,updatedAt:now,...expiry,entryExpiresAt:new Date(Math.min(+expiry.entryExpiresAt,Date.parse(plan.validUntil))),costBps:plan.estimatedCostBps,slippageBps:plan.estimatedSlippageBps}},{upsert:true,new:true,runValidators:true}).lean();
}
export async function updatePaperLedger(deadline=Date.now()+15000) {
  const signals=await SignalLedger.find({evaluationVersion:PAPER_EVALUATION_VERSION,status:{$in:['PENDING','OPEN','TARGET1']}}).sort({updatedAt:1}).limit(20).lean();
  if (!signals.length || Date.now() > deadline - 2500) return {checked:0,pending:signals.length};
  const now = new Date(), through = dateToISTString(now);
  const firstSignal = signals.map(signal => dateToISTString(new Date(signal.createdAt))).sort()[0];
  const from = [firstSignal, shiftDate(through, -100)].sort().at(-1)!;
  const actions = await beforeDeadline(() => getNsePriceBasisActions(from, through), Math.min(deadline - 1000, Date.now()+4500)).catch(() => null);
  let checked=0;
  for(const signal of signals){
    if(Date.now()>deadline-1000)break;
    const coverage = actions && dateToISTString(new Date(signal.createdAt)) >= from ? (actions.get(signal.symbol) ?? []) : null;
    // A known action or unavailable reference coverage needs no chart fetch.
    const actionDuringSignal = coverage?.some(day => day >= dateToISTString(new Date(signal.createdAt)));
    if (coverage && !actionDuringSignal && Date.now() > deadline-8500) break;
    const start=new Date(signal.checkedThrough??signal.createdAt);
    const series = coverage && !actionDuringSignal
      ? await beforeDeadline(() => fetchHistoricalCandleSeries(signal.symbol,'15m',
        new Date(Math.max(+start, +now - 55 * 86400000))), deadline - 1000).catch(() => null)
      : {candles:[], splitDays:[]};
    if (!series) break;
    const eligibility = typeof signal.casEligibleAtSignal === 'boolean'
      ? new Map([[signal.signalDate, signal.casEligibleAtSignal]]) : undefined;
    const next = evaluatePaperSignal(signal as PaperSignal, series.candles, now, eligibility,
      coverage && [...coverage, ...series.splitDays]);
    const {outcomeReason, ...values} = {status:next.status,entry:next.entry,filledAt:next.filledAt,closedAt:next.closedAt,checkedThrough:next.checkedThrough,target1At:next.target1At,target1Price:next.target1Price,exitPrice:next.exitPrice,realizedR:next.realizedR,outcomeReason:next.outcomeReason,updatedAt:new Date()};
    await SignalLedger.updateOne({_id:signal._id,status:signal.status,updatedAt:signal.updatedAt},
      outcomeReason ? {$set:{...values,outcomeReason}} : {$set:values,$unset:{outcomeReason:1}});
    checked++;
  }
  return {checked,pending:signals.length-checked};
}

import { SignalLedger } from './models/SignalLedger';
import { getTradePlan } from './tradePlan';
import { signalExpiry, evaluatePaperSignal, PAPER_EVALUATION_VERSION, type PaperSignal } from './ledgerEngine';
import type { ScreenedStock } from './screenerEngine';
import { todayIST } from './timezone';
import { AppError } from './operations';
import { fetchHistoricalCandles } from './dataFetcher';
import { STRATEGY_VERSION } from './strategyPolicy';
export async function recordPaperSignal(stock: ScreenedStock) {
  const plan=getTradePlan(stock);
  if (!plan?.accepted||stock.nearMiss||!stock.dataQuality||stock.dataQuality.stale||Date.parse(plan.validUntil)<=Date.now()) throw new AppError('NOT_QUALIFIED','Only current qualified research setups can enter the paper ledger.',422);
  const now=new Date(),expiry=signalExpiry(stock.mode,now,stock.casEligible??null);
  const query={symbol:stock.symbol,mode:stock.mode,signalDate:todayIST()};
  return SignalLedger.findOneAndUpdate(query,{$setOnInsert:{...query,evaluationVersion:PAPER_EVALUATION_VERSION,strategyVersion:STRATEGY_VERSION,decisionAt:now,quoteAt:stock.dataQuality.quoteAt,entry:plan.entry,entryLow:plan.entryLow,entryHigh:plan.entryHigh,stopLoss:plan.stopLoss,target1:plan.target1,target2:plan.target2,quantScore:stock.quantScore,rvolAtEntry:stock.relativeVolume?.value,rsiAtEntry:stock.rsi,sector:stock.sector,regime:stock.regime,riskPercent:stock.positionRiskPercent,status:'PENDING',createdAt:now,updatedAt:now,...expiry,entryExpiresAt:new Date(Math.min(+expiry.entryExpiresAt,Date.parse(plan.validUntil))),costBps:plan.estimatedCostBps,slippageBps:plan.estimatedSlippageBps}},{upsert:true,new:true,runValidators:true}).lean();
}
export async function updatePaperLedger(deadline=Date.now()+15000) {
  const signals=await SignalLedger.find({evaluationVersion:PAPER_EVALUATION_VERSION,status:{$in:['PENDING','OPEN','TARGET1']}}).sort({updatedAt:1}).limit(20).lean();
  let checked=0;
  for(const signal of signals){
    if(Date.now()>deadline-8500)break;
    const start=new Date(signal.checkedThrough??signal.createdAt);
    const candles=await fetchHistoricalCandles(signal.symbol,'15m',new Date(Math.max(+start,Date.now()-55*86400000)));
    const next=evaluatePaperSignal(signal as PaperSignal,candles);
    await SignalLedger.updateOne({_id:signal._id,status:signal.status},{$set:{status:next.status,entry:next.entry,filledAt:next.filledAt,closedAt:next.closedAt,checkedThrough:next.checkedThrough,target1At:next.target1At,target1Price:next.target1Price,exitPrice:next.exitPrice,realizedR:next.realizedR,outcomeReason:next.outcomeReason,updatedAt:new Date()}});
    checked++;
  }
  return {checked,pending:signals.length-checked};
}

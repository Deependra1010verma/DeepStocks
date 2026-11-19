import { NextRequest, NextResponse } from 'next/server';
import { requireCron, apiError } from '@/lib/apiSecurity';
import { getMarketSession, isAutomationWindow, isLongTermEodWindow, todayIST } from '@/lib/timezone';
import { validMode } from '@/lib/stockService';
import { getCachedScan, refreshScan, snapshotIsStale } from '@/lib/scanService';
import { recordPaperSignal, updatePaperLedger } from '@/lib/ledgerService';
import { queueAlert, deliverAlerts } from '@/lib/alertOutbox';
import { generateAndCache } from '@/lib/analysisService';
import { recordOperation, AppError } from '@/lib/operations';
import { Watchlist } from '@/lib/models/Watchlist';
import { fetchQuote } from '@/lib/dataFetcher';
import { connectDB } from '@/lib/db';
import { completeVerifiedCoverage } from '@/lib/scanProgress';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(req: NextRequest){
 const start=Date.now(),deadline=start+52000;
 try {
  requireCron(req);
  const mode=validMode(req.nextUrl.searchParams.get('mode')??'swing_breakout');
  const task=req.nextUrl.searchParams.get('task')??'scan';
  if(!['scan','ledger','alerts','warm'].includes(task))throw new AppError('INVALID_TASK','Unknown scheduler task.',400);
  const session=getMarketSession();
  const daily=mode==='longterm'||mode==='positional';
  const allowed=task==='alerts'||task==='ledger'?(isAutomationWindow()||isLongTermEodWindow()):daily?isLongTermEodWindow():isAutomationWindow();
  if(!allowed)return NextResponse.json({skipped:true,reason:'Outside verified task/session window',session});
  await connectDB();
  if(task==='ledger')return NextResponse.json({success:true,...await updatePaperLedger(deadline)});
  if(task==='alerts') {
   const watched=await Watchlist.find({userId:{$in:['owner','local']},alertEnabled:true}).limit(40).lean();
   for(const item of watched){
    if(Date.now()>deadline-18000)break;
    const quote=await fetchQuote(item.symbol),price=quote?.regularMarketPrice,time=quote?.regularMarketTime;
    if(typeof price!=='number'||!time||Date.now()-+new Date(time)>20*60000||item.zoneLow==null||item.zoneHigh==null||price<item.zoneLow||price>item.zoneHigh)continue;
    await queueAlert(`zone:${item.symbol}:${todayIST()}`,{mode:'watchlist',marketRegime:'RESEARCH',timestamp:new Date(time).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),stocks:[{symbol:item.symbol,name:item.symbol,cmp:price,dayChangePercent:quote?.regularMarketChangePercent??0,quantScore:0,rsi:0,rvol:0,defaultSL:item.zoneLow,target1:item.zoneHigh}]},new Date(Date.now()+15*60000));
   }
   return NextResponse.json({success:true,...await deliverAlerts(deadline)});
  }
  if(task==='warm'){
   const snapshot=await getCachedScan(mode,'All');
   if(!snapshot||snapshotIsStale(snapshot)||!completeVerifiedCoverage(snapshot.coverage))return NextResponse.json({skipped:true,reason:'Complete verified scan required before AI warming'});
   let warmed=0;
   for(const stock of snapshot.stocks.filter(s=>!s.nearMiss&&!s.dataQuality?.stale).slice(0,3)){
    if(Date.now()>deadline-30000)break;
    try{await generateAndCache(stock);warmed++;}catch{break;}
   }
   return NextResponse.json({success:true,warmed});
  }
  const snapshot=await refreshScan(mode,'All',deadline-3000);
  if(snapshotIsStale(snapshot)||!completeVerifiedCoverage(snapshot.coverage)){
   return NextResponse.json({skipped:true,reason:'Complete verified scan required before recording signals or setup alerts',coverage:snapshot.coverage});
  }
  for(const stock of snapshot.stocks.filter(s=>!s.nearMiss&&!s.dataQuality?.stale&&s.quantScore>=65&&s.primaryRank).slice(0,5)){
   if(Date.now()>deadline-3000)break;
   await recordPaperSignal(stock);
   await queueAlert(`setup:${mode}:${stock.symbol}:${todayIST()}`,{mode,marketRegime:stock.regime??'NEUTRAL',timestamp:stock.dataQuality?.quoteAt??snapshot.generatedAt.toISOString(),stocks:[stock]},new Date(Date.now()+15*60000));
  }
  await recordOperation(`cron:${mode}`,{status:'ok',task,coverage:snapshot.coverage,latencyMs:Date.now()-start});
  return NextResponse.json({success:true,mode,coverage:snapshot.coverage,generatedAt:snapshot.generatedAt,delivery:'Queued; alerts task delivers with expiry/deduplication'});
 }catch(e){if(!(e instanceof AppError&&e.status===401))await recordOperation('cron',{status:e instanceof AppError?e.code:'FAILED'});return apiError(e);}
}

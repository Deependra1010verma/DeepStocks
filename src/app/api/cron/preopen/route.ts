import { NextRequest, NextResponse } from 'next/server';
import { requireCron, apiError } from '@/lib/apiSecurity';
import { isPreOpenWindow, todayIST, dateToISTString } from '@/lib/timezone';
import { connectDB } from '@/lib/db';
import { Watchlist } from '@/lib/models/Watchlist';
import { ScanSnapshot } from '@/lib/models/ScanSnapshot';
import { fetchQuote } from '@/lib/dataFetcher';
import { getTradePlan } from '@/lib/tradePlan';
import type { ScreenedStock } from '@/lib/screenerEngine';
import { queueAlert, deliverAlerts } from '@/lib/alertOutbox';
import { SCAN_VERSION } from '@/lib/scanService';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(req:NextRequest){
 try{
  requireCron(req);if(!isPreOpenWindow())return NextResponse.json({skipped:true,reason:'Outside verified 09:12–09:15 cash pre-open window'});
  await connectDB();const deadline=Date.now()+45000;
  const [snapshots,watchlist]=await Promise.all([ScanSnapshot.find({sector:'All',version:SCAN_VERSION,generatedAt:{$gte:new Date(Date.now()-4*86400000)}}).lean(),Watchlist.find({userId:{$in:['owner','local']},alertEnabled:true}).lean()]);
  const zones=new Map<string,number>();
  for(const snapshot of snapshots)for(const stock of snapshot.stocks as ScreenedStock[]){const plan=getTradePlan(stock);if(plan&&!stock.nearMiss)zones.set(stock.symbol,plan.entryHigh);}
  for(const w of watchlist)if(w.zoneHigh)zones.set(w.symbol,w.zoneHigh);
  let verifiedQuotes=0,alerts=0;
  for(const [symbol,entryHigh]of zones){
   if(Date.now()>deadline-18000)break;
   const quote=await fetchQuote(symbol),price=quote?.preMarketPrice,at=quote?.preMarketTime;
   if(typeof price!=='number'||!at||dateToISTString(new Date(at))!==todayIST()||Date.now()-+new Date(at)>120000||+new Date(at)>Date.now()+10000||quote?.marketState!=='PRE')continue;
   verifiedQuotes++;
   const previous=quote?.regularMarketPreviousClose;
   if(!previous||price<=entryHigh||price/previous<1.04)continue;
   alerts++;
   await queueAlert(`preopen:${symbol}:${todayIST()}`,{mode:'preopen-gap',marketRegime:'INDICATIVE AUCTION',timestamp:new Date(at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}),stocks:[{symbol,name:symbol,cmp:price,dayChangePercent:(price/previous-1)*100,quantScore:0,rsi:0,rvol:0,defaultSL:0,target1:0}]},new Date(`${todayIST()}T09:15:00+05:30`));
  }
  const delivery=await deliverAlerts(deadline);
  return NextResponse.json({success:true,requested:zones.size,verifiedQuotes,alerts,...delivery,unavailable:verifiedQuotes===0,note:'Yahoo pre-market data is indicative; this does not certify the final auction opening price.'});
 }catch(e){return apiError(e);}
}

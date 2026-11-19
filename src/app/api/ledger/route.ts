import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/db';
import { SignalLedger } from '@/lib/models/SignalLedger';
import { requireOwner, authorizeRequest, apiError, readBody } from '@/lib/apiSecurity';
import { validMode, validSymbol, resolveStock } from '@/lib/stockService';
import { recordPaperSignal } from '@/lib/ledgerService';
import { summarizePaperSignals, PAPER_EVALUATION_VERSION, type PaperSignal } from '@/lib/ledgerEngine';
import { AppError } from '@/lib/operations';
import { STRATEGY_VERSION } from '@/lib/strategyPolicy';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(req: NextRequest) {
 try {
  requireOwner(req);await connectDB();
  const mode=req.nextUrl.searchParams.get('mode'); const query=mode?{mode:validMode(mode)}:{};
  const items=await SignalLedger.find(query).sort({signalDate:-1}).limit(500).lean();
  const closed=await SignalLedger.find({...query,evaluationVersion:PAPER_EVALUATION_VERSION,closedAt:{$exists:true}}).sort({closedAt:1}).limit(10000).lean();
  const summarize=(list:typeof closed)=>summarizePaperSignals(list as Array<PaperSignal & {evaluationVersion?:number}>);
  const stats=summarize(closed);
  const currentRvol=closed.filter(s=>s.strategyVersion===STRATEGY_VERSION);
  const byRvol={high:summarize(currentRvol.filter(s=>s.rvolAtEntry!=null&&s.rvolAtEntry>=1.8)),low:summarize(currentRvol.filter(s=>s.rvolAtEntry!=null&&s.rvolAtEntry<1.8))};
  const bySector=[...new Set(closed.map(s=>s.sector??'Unknown'))].map(sector=>({sector,...summarize(closed.filter(s=>(s.sector??'Unknown')===sector))}));
  const byStrategyVersion=[...new Set(closed.map(s=>s.strategyVersion??'prior'))].map(version=>({version,...summarize(closed.filter(s=>(s.strategyVersion??'prior')===version))}));
  return NextResponse.json({items,stats:{...stats,byRvol,bySector,byStrategyVersion},historyCapped:closed.length===10000,unavailable:false},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return apiError(e);}
}
export async function POST(req: NextRequest) {
 try {
  await authorizeRequest(req,'ledger',10);const body=await readBody(req);
  if(Object.keys(body).some(k=>!['symbol','mode'].includes(k)))throw new AppError('INVALID_REQUEST','Paper signals use server-computed levels only.',400);
  const stock=await resolveStock(validSymbol(body.symbol),validMode(body.mode));await connectDB();
  return NextResponse.json({item:await recordPaperSignal(stock)});
 }catch(e){return apiError(e);}
}

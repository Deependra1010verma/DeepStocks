import { NextRequest, NextResponse } from 'next/server';
import { getCachedScan, refreshScan, snapshotIsStale } from '@/lib/scanService';
import { validMode } from '@/lib/stockService';
import { SECTORS } from '@/lib/niftyStocks';
import { authorizeRequest, requireOwner, apiError, readBody } from '@/lib/apiSecurity';
import { AppError } from '@/lib/operations';
import { beforeDeadline, DeadlineError } from '@/lib/deadline';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
function sectorOf(value: unknown): string { const sector=String(value??'All');if(sector!=='All'&&!SECTORS.includes(sector))throw new AppError('INVALID_SECTOR','Invalid sector.',400);return sector; }
export async function GET(req: NextRequest) {
 try { requireOwner(req); const mode=validMode(req.nextUrl.searchParams.get('mode')??'swing_breakout'), sector=sectorOf(req.nextUrl.searchParams.get('sector')); const cached=await getCachedScan(mode,sector); return NextResponse.json(cached?{...cached,mode,sector,stale:snapshotIsStale(cached)}:{stocks:[],removedToday:[],mode,sector,stale:true,needsRefresh:true},{headers:{'Cache-Control':'no-store'}}); }
 catch(e){return apiError(e);}
}
export async function POST(req: NextRequest) {
 try {
   const body = await beforeDeadline(async () => { await authorizeRequest(req,'scan',4); return readBody(req); }, Date.now() + 4000);
   const mode=validMode(body.mode),sector=sectorOf(body.sector);
   const result=await refreshScan(mode,sector);
   return NextResponse.json({...result,mode,sector,stale:snapshotIsStale(result)});
 } catch(e){return apiError(e instanceof DeadlineError ? new AppError('SCAN_START_TIMEOUT','Scan could not start in time. Saved results are retained; retry shortly.',504,60) : e);}
}

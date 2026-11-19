import { NextRequest, NextResponse } from 'next/server';
import { authorizeRequest, apiError, readBody } from '@/lib/apiSecurity';
import { generateAndCache } from '@/lib/analysisService';
import { resolveStock, validMode, validSymbol } from '@/lib/stockService';
import { AppError } from '@/lib/operations';
import { providerConfig } from '@/lib/aiProvider';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  try {
    await authorizeRequest(req, 'analyze', 12);
    const body = await readBody(req);
    const symbol=validSymbol(body.symbol), mode=validMode(body.mode);
    if(!providerConfig().configured) throw new AppError('AI_NOT_CONFIGURED','AI provider key is not configured. Quant research remains available.');
    if (req.signal.aborted) throw new AppError('CANCELLED','Request cancelled.',499);
    const stock = await resolveStock(symbol, mode);
    if (req.signal.aborted) throw new AppError('CANCELLED','Request cancelled.',499);
    if (!stock.dataQuality || stock.dataQuality.stale) {
      const issues = stock.dataQuality?.issues ?? [];
      const reason = issues.length ? issues.join('. ') : 'Stock data freshness could not be verified';
      return NextResponse.json(
        {code:'STALE_DATA', error:reason + '. The chart and quant research are still available below.', stock},
        {status:422, headers:{'Cache-Control':'no-store'}}
      );
    }
    return NextResponse.json(await generateAndCache(stock, body.forceRefresh === true), { headers: { 'Cache-Control': 'no-store' } });
  } catch(error) { return apiError(error); }
}

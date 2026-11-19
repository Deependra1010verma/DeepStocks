import { NextRequest, NextResponse } from 'next/server';
import { authorizeRequest, apiError, readBody } from '@/lib/apiSecurity';
import { resolveStock, validMode, validSymbol } from '@/lib/stockService';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  try { await authorizeRequest(req,'stock',15); const body=await readBody(req); const mode=validMode(body.mode); const stock=await resolveStock(validSymbol(body.symbol),mode); return NextResponse.json({stock,mode}); }
  catch(error) { return apiError(error); }
}

import { NextRequest, NextResponse } from 'next/server';
import { requireOwner, authorizeRequest, apiError } from '@/lib/apiSecurity';
import { readGrowwHoldings, readGrowwQuote } from '@/lib/growwReadOnly';
import { validSymbol } from '@/lib/stockService';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  try {
    requireOwner(req);
    if (req.nextUrl.searchParams.get('status') === '1')
      return NextResponse.json(
        {
          provider: 'Groww',
          configured: Boolean(process.env.GROWW_ACCESS_TOKEN),
          access: 'read-only in this application',
          subscriptionRequired: true
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    await authorizeRequest(req, 'broker-read', 10);
    const symbol = req.nextUrl.searchParams.get('symbol');
    return NextResponse.json(
      symbol
        ? { quote: await readGrowwQuote(validSymbol(symbol)) }
        : {
            holdings: await readGrowwHoldings(),
            asOf: new Date().toISOString(),
            notice:
              'Comparison only; holdings, locked quantities, intraday positions and cash need reconciliation before journal updates.'
          },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return apiError(e);
  }
}

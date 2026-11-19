import { NextRequest, NextResponse } from 'next/server';
import { requireCron, apiError } from '@/lib/apiSecurity';
import { getInstrumentMaster, refreshInstrumentMaster } from '@/lib/marketReference';
import { beforeDeadline } from '@/lib/deadline';
import { withLease } from '@/lib/operations';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  try {
    requireCron(req);
    const result = await beforeDeadline(
      () =>
        withLease(
          'instruments',
          async () => {
            const existing = await getInstrumentMaster();
            if (existing)
              return {
                asOf: existing.asOf,
                count: existing.instruments.length,
                source: existing.source,
                cached: true
              };
            return refreshInstrumentMaster();
          },
          40000
        ),
      Date.now() + 26000
    );
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { requireOwner, apiError } from '@/lib/apiSecurity';
import { getSectorBenchmarks, SECTOR_BENCHMARK_COUNT, SECTOR_REPORT_SOURCE } from '@/lib/sectorBenchmarks';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    requireOwner(req);
    const benchmarks = await getSectorBenchmarks();
    const allSectors = benchmarks.map(item => ({ ...item, changePercent: item.relativeChange }));
    return NextResponse.json({
      topSectors: allSectors.filter(item => item.relativeChange > 0).slice(0, 4),
      weakSectors: allSectors.filter(item => item.relativeChange < 0).slice(-3),
      allSectors,
      asOf: benchmarks[0]?.asOf ?? null,
      source: SECTOR_REPORT_SOURCE,
      coverage: { requested: SECTOR_BENCHMARK_COUNT, processed: benchmarks.length }
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

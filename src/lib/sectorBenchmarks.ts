import { getIndexSession, type ExchangeClose } from './nseSessionData';
import { calendarDay, latestCompletedSession, shiftDate } from './timezone';
import type { ScreenerMode } from './screenerEngine';

const SECTOR_INDEXES = {
  Banking: 'Nifty Bank',
  IT: 'Nifty IT',
  FMCG: 'Nifty FMCG',
  Energy: 'Nifty Energy',
  Auto: 'Nifty Auto',
  Pharma: 'Nifty Pharma',
  Infrastructure: 'Nifty Infrastructure',
  Telecom: 'Nifty Telecommunications',
  Healthcare: 'Nifty Healthcare Index',
  'Capital Goods': 'Nifty Capital Goods',
  'Real Estate': 'Nifty Realty',
  Media: 'Nifty Media'
} as const;
export const SECTOR_BENCHMARK_COUNT = Object.keys(SECTOR_INDEXES).length;
export const SECTOR_REPORT_SOURCE = 'https://www.niftyindices.com/reports/daily-reports';
export function usesSectorBenchmark(mode: ScreenerMode) {
  return mode === 'swing_breakout' || mode === 'swing_pullback' || mode === 'positional';
}

export interface SectorBenchmark {
  sector: string;
  index: string;
  from: string;
  asOf: string;
  sectorReturn: number;
  niftyReturn: number;
  relativeChange: number;
  scoreBoost: number;
}

export function sectorBenchmarks(
  start: ReadonlyMap<string, ExchangeClose>,
  end: ReadonlyMap<string, ExchangeClose>,
  from: string,
  asOf: string
): SectorBenchmark[] {
  const change = (index: string) => {
    const initial = start.get(index)?.candle.close;
    const latest = end.get(index)?.candle.close;
    return initial && latest && initial > 0 && latest > 0 ? 100 * (latest / initial - 1) : null;
  };
  const niftyReturn = change('^NSEI');
  if (niftyReturn == null || !Number.isFinite(niftyReturn)) return [];
  return Object.entries(SECTOR_INDEXES)
    .flatMap(([sector, index]) => {
      const sectorReturn = change(index);
      if (sectorReturn == null || !Number.isFinite(sectorReturn)) return [];
      const relativeChange = sectorReturn - niftyReturn;
      return [
        {
          sector,
          index,
          from,
          asOf,
          sectorReturn,
          niftyReturn,
          relativeChange,
          scoreBoost: relativeChange > 0 ? 10 : 0
        }
      ];
    })
    .sort((a, b) => b.relativeChange - a.relativeChange);
}

export async function getSectorBenchmarks(now = new Date()): Promise<SectorBenchmark[]> {
  const asOf = latestCompletedSession(now);
  if (!asOf) return [];
  let from = asOf;
  let remaining = 20;
  for (let i = 0; remaining > 0 && i < 45; i++) {
    from = shiftDate(from, -1);
    if (calendarDay(from).trading) remaining--;
  }
  if (remaining) return [];
  const [start, end] = await Promise.all([getIndexSession(from), getIndexSession(asOf)]);
  return sectorBenchmarks(start, end, from, asOf);
}

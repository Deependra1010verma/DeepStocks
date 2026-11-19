import { parseCSV } from './csv';
import { readBoundedReport } from './nsePublicReports';
import { dateToISTString, latestCompletedSession } from './timezone';

export const NSE_PRICE_BANDS_SOURCE = 'https://nsearchives.nseindia.com/content/equities/sec_list.csv';
export interface NsePriceBand {
  percent: number | null;
  publishedDay: string;
}

export function parseNsePriceBands(csv: string, publishedDay: string) {
  const [header, ...rows] = parseCSV(csv);
  const fields = header?.map((key) => key.trim().replace(/^\uFEFF/, '')) ?? [];
  const symbolIndex = fields.indexOf('Symbol');
  const seriesIndex = fields.indexOf('Series');
  const bandIndex = fields.indexOf('Band');
  const entries = new Map<string, NsePriceBand>();
  if ([symbolIndex, seriesIndex, bandIndex].some((index) => index < 0)) return entries;
  const ambiguous = new Set<string>();
  for (const row of rows) {
    const symbol = row[symbolIndex]?.trim();
    const value = row[bandIndex]?.trim();
    if (!symbol || !/^[A-Z0-9&-]{1,25}$/.test(symbol) || row[seriesIndex]?.trim() !== 'EQ') continue;
    const percent = value === 'No Band' ? null : Number(value);
    if (percent != null && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) continue;
    const key = symbol + '.NS';
    const prior = entries.get(key);
    if (prior && prior.percent !== percent) ambiguous.add(key);
    entries.set(key, { percent, publishedDay });
  }
  for (const key of ambiguous) entries.delete(key);
  return entries;
}

let cache:
  { key: string; expires: number; data: Promise<ReadonlyMap<string, NsePriceBand>> } | undefined;
export function getNsePriceBands(now = new Date()) {
  const required = latestCompletedSession(now);
  const key = dateToISTString(now) + ':' + required;
  if (cache?.key === key && cache.expires > Date.now()) return cache.data;
  const state = {
    key,
    expires: Date.now() + 60_000,
    data: Promise.resolve().then(async () => {
      try {
        const response = await fetch(NSE_PRICE_BANDS_SOURCE, {
          signal: AbortSignal.timeout(4300),
          redirect: 'error'
        });
        const modified = new Date(response.headers.get('last-modified') ?? '');
        if (!required || !Number.isFinite(+modified) || +modified > +now + 60_000)
          return new Map<string, NsePriceBand>();
        const publishedDay = dateToISTString(modified);
        if (publishedDay < required) return new Map<string, NsePriceBand>();
        const csv = await readBoundedReport(response, 512_000);
        const entries = csv ? parseNsePriceBands(csv, publishedDay) : new Map<string, NsePriceBand>();
        if (entries.size < 500) return new Map<string, NsePriceBand>();
        state.expires = Date.now() + 15 * 60_000;
        return entries;
      } catch {
        return new Map<string, NsePriceBand>();
      }
    })
  };
  cache = state;
  return state.data;
}

import { parseEventDay } from './nseCorporateEvents';
import { nseReportUrl, readNsePublicReport } from './nsePublicReports';
import { dateToISTString } from './timezone';

export interface SurveillanceEntry {
  measure: 'ASM' | 'GSM';
  asOf: string;
  isin: string;
  code: string;
  source: string;
}

export function parseSurveillanceReports(asm: unknown, gsm: unknown, now = new Date()) {
  const result = new Map<string, SurveillanceEntry[]>();
  const today = dateToISTString(now);
  function addRows(rows: unknown, measure: SurveillanceEntry['measure']) {
    if (!Array.isArray(rows) || rows.length > 3000) return;
    for (const row of rows) {
      if (!row || typeof row.symbol !== 'string' || !/^[A-Z0-9&-]{1,25}$/.test(row.symbol)) continue;
      if (typeof row.isin !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(row.isin)) continue;
      const time = measure === 'ASM' ? row.asmTime : row.gsmTime;
      const asOf = parseEventDay(typeof time === 'string' ? time.trim().split(/\s+/)[0] : null);
      if (
        !asOf ||
        asOf > today ||
        typeof row.survCode !== 'string' ||
        !/^[ A-Za-z0-9&/().-]{1,90}$/.test(row.survCode)
      )
        continue;
      const entries = result.get(row.symbol + '.NS') ?? [];
      const code = row.survCode;
      if (
        !entries.some(
          (entry) => entry.measure === measure && entry.code === code && entry.isin === row.isin
        )
      ) {
        entries.push({
          measure,
          asOf,
          isin: row.isin,
          code,
          source: nseReportUrl(measure === 'ASM' ? '/api/reportASM' : '/api/reportGSM')
        });
        result.set(row.symbol + '.NS', entries);
      }
    }
  }
  const asmReport = asm as { longterm?: { data?: unknown }; shortterm?: { data?: unknown } } | null;
  addRows(asmReport?.longterm?.data, 'ASM');
  addRows(asmReport?.shortterm?.data, 'ASM');
  addRows(gsm, 'GSM');
  return result;
}

let cache: { expiry: number; result: Promise<ReadonlyMap<string, SurveillanceEntry[]>> } | undefined;
export function getNseSurveillance() {
  if (cache && cache.expiry > Date.now()) return cache.result;
  const state = {
    expiry: Date.now() + 60_000,
    result: Promise.all([
      readNsePublicReport('/api/reportASM'),
      readNsePublicReport('/api/reportGSM')
    ]).then(([asm, gsm]) => {
      const flags = parseSurveillanceReports(asm, gsm);
      if (asm && gsm && flags.size) state.expiry = Date.now() + 15 * 60_000;
      return flags;
    })
  };
  cache = state;
  return state.result;
}

import { parseEventDay } from './nseCorporateEvents';
import { nseReportUrl, readNsePublicReport, REPORT_TTL_MS, reportStatus, validReportRows, type ReportStatus } from './nsePublicReports';
import { dateToISTString } from './timezone';

export interface SurveillanceEntry {
  measure: 'ASM' | 'GSM';
  asOf: string;
  isin: string;
  code: string;
  source: string;
}

function surveillanceRow(row: Record<string, unknown>, measure: SurveillanceEntry['measure'], today: string) {
  const time = measure === 'ASM' ? row.asmTime : row.gsmTime;
  const asOf = parseEventDay(typeof time === 'string' ? time.trim().split(/\s+/)[0] : null);
  return typeof row.symbol === 'string' && /^[A-Z0-9&-]{1,25}$/.test(row.symbol) &&
    typeof row.isin === 'string' && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(row.isin) &&
    asOf && asOf <= today && typeof row.survCode === 'string' &&
    /^[ A-Za-z0-9&/().-]{1,90}$/.test(row.survCode)
    ? {symbol:row.symbol, isin:row.isin, code:row.survCode, asOf} : null;
}

export function parseSurveillanceReports(asm: unknown, gsm: unknown, now = new Date()) {
  const result = new Map<string, SurveillanceEntry[]>();
  const today = dateToISTString(now);
  function addRows(rows: unknown, measure: SurveillanceEntry['measure']) {
    if (!Array.isArray(rows) || rows.length > 3000) return;
    for (const row of rows) {
      const parsed = row && surveillanceRow(row, measure, today);
      if (!parsed) continue;
      const {symbol, isin, code, asOf} = parsed;
      const entries = result.get(symbol + '.NS') ?? [];
      if (
        !entries.some(
          (entry) => entry.measure === measure && entry.code === code && entry.isin === isin
        )
      ) {
        entries.push({
          measure,
          asOf,
          isin,
          code,
          source: nseReportUrl(measure === 'ASM' ? '/api/reportASM' : '/api/reportGSM')
        });
        result.set(symbol + '.NS', entries);
      }
    }
  }
  const asmReport = asm as { longterm?: { data?: unknown }; shortterm?: { data?: unknown } } | null;
  addRows(asmReport?.longterm?.data, 'ASM');
  addRows(asmReport?.shortterm?.data, 'ASM');
  addRows(gsm, 'GSM');
  return result;
}

export interface NseSurveillanceReports {
  entries: ReadonlyMap<string, SurveillanceEntry[]>;
  asm: ReportStatus;
  gsm: ReportStatus;
}

let cache: { day: string; expiry: number; result: Promise<NseSurveillanceReports> } | undefined;
export function getNseSurveillanceReports(): Promise<NseSurveillanceReports> {
  const checkedAt = new Date(), day = dateToISTString(checkedAt);
  if (cache?.day === day && cache.expiry > +checkedAt) return cache.result;
  const state = {
    day,
    expiry: +checkedAt + 60_000,
    result: Promise.all([
      readNsePublicReport('/api/reportASM'),
      readNsePublicReport('/api/reportGSM')
    ]).then(([asmPayload, gsmPayload]) => {
      const entries = parseSurveillanceReports(asmPayload, gsmPayload, checkedAt);
      const asm = asmPayload as { longterm?: { data?: unknown }; shortterm?: { data?: unknown } } | null;
      const validAsmRow = (row: Record<string, unknown>) => surveillanceRow(row, 'ASM', day) !== null;
      const validAsm = validReportRows(asm?.longterm?.data, validAsmRow) &&
        validReportRows(asm?.shortterm?.data, validAsmRow);
      const validGsm = validReportRows(gsmPayload, row => surveillanceRow(row, 'GSM', day) !== null);
      if (validAsm && validGsm) state.expiry = +checkedAt + REPORT_TTL_MS;
      const flags = [...entries.values()].flat();
      return {
        entries,
        asm: reportStatus(validAsm, flags.filter(flag => flag.measure === 'ASM').length, checkedAt),
        gsm: reportStatus(validGsm, flags.filter(flag => flag.measure === 'GSM').length, checkedAt)
      };
    })
  };
  cache = state;
  return state.result;
}

export async function getNseSurveillance(): Promise<ReadonlyMap<string, SurveillanceEntry[]>> {
  return (await getNseSurveillanceReports()).entries;
}

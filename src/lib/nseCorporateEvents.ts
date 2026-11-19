import { dateToISTString } from './timezone';
import { nseReportUrl, readNsePublicReport, REPORT_TTL_MS, reportStatus, validReportRows, type ReportStatus } from './nsePublicReports';

const ACTIONS_PATH = '/api/corporates-corporateActions?index=equities';
const MEETINGS_PATH = '/api/event-calendar';
const FILINGS_PATH = '/api/corporate-board-meetings?index=equities';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NSE_SYMBOL = /^[A-Z0-9&-]{1,25}$/;
const PRICE_BASIS_ACTION = /\b(?:bonus|split|sub[ -]?division|consolidation|rights|merger|amalgamation|demerger|spin[ -]?off|capital reduction|scheme of arrangement)\b/i;
const ACTION_TYPES = [
  [/\bbonus\b/i, 'Bonus'],
  [/\b(split|sub-division|subdivision|consolidation)\b/i, 'Split or consolidation'],
  [/\b(dividend|distribution)\b/i, 'Dividend'],
  [/\b(rights|buyback|merger|amalgamation|demerger|spin.?off)\b/i, 'Corporate restructuring']
] as const;

export interface NseCorporateEvent {
  kind: 'earnings' | 'action';
  day: string;
  label: string;
  source: string;
  publishedAt?: string;
  changesPriceBasis?: boolean;
}

export function parseEventDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!parts) return null;
  const [, day, month, year] = parts;
  const index = MONTHS.findIndex((item) => item.toLowerCase() === month.toLowerCase());
  if (index < 0) return null;
  const iso = `${year}-${String(index + 1).padStart(2, '0')}-${day}`;
  const date = new Date(iso + 'T12:00:00+05:30');
  return Number.isFinite(+date) && dateToISTString(date) === iso ? iso : null;
}

export function parseNseEvents(payload: unknown, kind: NseCorporateEvent['kind'], now = new Date()) {
  const events = new Map<string, NseCorporateEvent[]>();
  if (!Array.isArray(payload) || payload.length > 3000) return events;
  const today = dateToISTString(now);
  for (const row of payload) {
    if (!row || typeof row.symbol !== 'string' || !NSE_SYMBOL.test(row.symbol)) continue;
    if (kind === 'action' && row.series !== 'EQ') continue;
    const day = parseEventDay(kind === 'earnings' ? row.date : row.exDate);
    if (!day || day < today) continue;
    const label =
      kind === 'earnings'
        ? typeof row.purpose === 'string' && /\bfinancial results\b/i.test(row.purpose)
          ? 'Financial results meeting'
          : null
        : typeof row.subject === 'string'
          ? ACTION_TYPES.find(([pattern]) => pattern.test(row.subject))?.[1] ??
            (PRICE_BASIS_ACTION.test(row.subject) ? 'Corporate restructuring' : null)
          : null;
    if (!label) continue;
    const symbol = row.symbol + '.NS';
    const matches = events.get(symbol) ?? [];
    if (!matches.some((item) => item.day === day && item.label === label)) {
      matches.push({
        kind,
        day,
        label,
        source: nseReportUrl(kind === 'earnings' ? MEETINGS_PATH : ACTIONS_PATH),
        ...(kind === 'action' && PRICE_BASIS_ACTION.test(row.subject) ? {changesPriceBasis:true} : {})
      });
      events.set(symbol, matches);
    }
  }
  return events;
}

function validActionRow(row: Record<string, unknown>) {
  return typeof row.symbol === 'string' && NSE_SYMBOL.test(row.symbol) &&
    typeof row.series === 'string' && typeof row.subject === 'string' &&
    (row.series !== 'EQ' || parseEventDay(row.exDate) !== null);
}

let priceBasisHistory: { key: string; expires: number; request: Promise<ReadonlyMap<string, string[]> | null> } | undefined;

// A single bounded exchange read covers all symbols in a paper update.
export function getNsePriceBasisActions(from: string, through: string): Promise<ReadonlyMap<string, string[]> | null> {
  if (![from, through].every(day => /^\d{4}-\d{2}-\d{2}$/.test(day))) return Promise.resolve(null);
  const span = Date.parse(through) - Date.parse(from);
  if (!Number.isFinite(span) || span < 0 || span > 100 * 86_400_000) return Promise.resolve(null);
  const key = from + ':' + through, now = Date.now();
  if (priceBasisHistory?.key === key && priceBasisHistory.expires > now) return priceBasisHistory.request;
  const format = (day: string) => day.split('-').reverse().join('-');
  const filters = new URLSearchParams({from_date: format(from), to_date: format(through)});
  const request = readNsePublicReport(ACTIONS_PATH, filters).then(payload => {
    if (!Array.isArray(payload) || payload.length >= 3000 || !validReportRows(payload, validActionRow)) return null;
    const result = new Map<string, string[]>();
    for (const row of payload) {
      if (row.series !== 'EQ') continue;
      const day = parseEventDay(row.exDate)!;
      if (day < from || day > through) return null;
      if (!PRICE_BASIS_ACTION.test(row.subject)) continue;
      const symbol = row.symbol + '.NS';
      const days = result.get(symbol) ?? [];
      if (!days.includes(day)) result.set(symbol, [...days,day]);
    }
    return result;
  });
  const state = {key, expires: now + 60_000, request};
  priceBasisHistory = state;
  void request.then(result => { if (result) state.expires = now + REPORT_TTL_MS; });
  return request;
}

export function attachResultsFilings(
  earnings: Map<string, NseCorporateEvent[]>,
  payload: unknown,
  now = new Date()
) {
  if (!Array.isArray(payload) || payload.length > 3000) return;
  for (const row of payload) {
    if (!row || typeof row.bm_symbol !== 'string' || typeof row.bm_timestamp !== 'string') continue;
    const day = parseEventDay(row.bm_date);
    const [publicationDate, time] = row.bm_timestamp.trim().split(/\s+/);
    const publishedDay = parseEventDay(publicationDate);
    if (!day || !publishedDay || publishedDay > day || !/^\d{2}:\d{2}:\d{2}$/.test(time ?? '')) continue;
    const publishedAt = Date.parse(publishedDay + 'T' + time + '+05:30');
    if (!Number.isFinite(publishedAt) || publishedAt > +now || typeof row.attachment !== 'string')
      continue;
    if (typeof row.bm_desc !== 'string' || !/\bfinancial results\b/i.test(row.bm_desc)) continue;
    let source: URL;
    try {
      source = new URL(row.attachment);
    } catch {
      continue;
    }
    if (
      source.protocol !== 'https:' ||
      !['nsearchives.nseindia.in', 'nsearchives.nseindia.com', 'archives.nseindia.com'].includes(
        source.host
      ) ||
      !source.pathname.startsWith('/corporate/') ||
      source.username ||
      source.password
    )
      continue;
    const event = earnings.get(row.bm_symbol + '.NS')?.find((item) => item.day === day);
    if (event && (!event.publishedAt || Date.parse(event.publishedAt) < publishedAt)) {
      event.publishedAt = new Date(publishedAt).toISOString();
      event.source = source.toString();
    }
  }
}

export interface NseEventReports {
  entries: ReadonlyMap<string, NseCorporateEvent[]>;
  earnings: ReportStatus;
  actions: ReportStatus;
}

let lookup: { day: string; expiresAt: number; data: Promise<NseEventReports> } | undefined;
export function getNseEventReports(): Promise<NseEventReports> {
  const checkedAt = new Date(), day = dateToISTString(checkedAt);
  if (lookup?.day === day && lookup.expiresAt > +checkedAt) return lookup.data;
  const state = {
    day,
    expiresAt: +checkedAt + 60_000,
    data: Promise.all([
      readNsePublicReport(MEETINGS_PATH),
      readNsePublicReport(ACTIONS_PATH),
      readNsePublicReport(FILINGS_PATH)
    ]).then(([meetingsPayload, actionsPayload, filings]) => {
      const earnings = parseNseEvents(meetingsPayload, 'earnings', checkedAt);
      const actions = parseNseEvents(actionsPayload, 'action', checkedAt);
      attachResultsFilings(earnings, filings, checkedAt);
      const validEarnings = validReportRows(meetingsPayload, row =>
        typeof row.symbol === 'string' && NSE_SYMBOL.test(row.symbol) && typeof row.purpose === 'string' &&
        (!/\bfinancial results\b/i.test(row.purpose) || parseEventDay(row.date) !== null));
      const validActions = validReportRows(actionsPayload, validActionRow);
      const combined = new Map<string, NseCorporateEvent[]>(earnings);
      for (const [symbol, items] of actions)
        combined.set(symbol, [...(combined.get(symbol) ?? []), ...items]);
      for (const events of combined.values()) events.sort((a, b) => a.day.localeCompare(b.day));
      if (validEarnings && validActions) state.expiresAt = +checkedAt + REPORT_TTL_MS;
      return {
        entries: combined,
        earnings: reportStatus(validEarnings, earnings.size, checkedAt),
        actions: reportStatus(validActions, actions.size, checkedAt)
      };
    })
  };
  lookup = state;
  return state.data;
}

export async function getNseEvents(): Promise<ReadonlyMap<string, NseCorporateEvent[]>> {
  return (await getNseEventReports()).entries;
}

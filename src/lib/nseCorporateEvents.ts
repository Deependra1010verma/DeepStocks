import { dateToISTString } from './timezone';
import { nseReportUrl, readNsePublicReport } from './nsePublicReports';

const ACTIONS_PATH = '/api/corporates-corporateActions?index=equities';
const MEETINGS_PATH = '/api/event-calendar';
const FILINGS_PATH = '/api/corporate-board-meetings?index=equities';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
    if (!row || typeof row.symbol !== 'string' || !/^[A-Z0-9&-]{1,25}$/.test(row.symbol)) continue;
    if (kind === 'action' && row.series !== 'EQ') continue;
    const day = parseEventDay(kind === 'earnings' ? row.date : row.exDate);
    if (!day || day < today) continue;
    const label =
      kind === 'earnings'
        ? typeof row.purpose === 'string' && /\bfinancial results\b/i.test(row.purpose)
          ? 'Financial results meeting'
          : null
        : typeof row.subject === 'string'
          ? ACTION_TYPES.find(([pattern]) => pattern.test(row.subject))?.[1]
          : null;
    if (!label) continue;
    const symbol = row.symbol + '.NS';
    const matches = events.get(symbol) ?? [];
    if (!matches.some((item) => item.day === day && item.label === label)) {
      matches.push({
        kind,
        day,
        label,
        source: nseReportUrl(kind === 'earnings' ? MEETINGS_PATH : ACTIONS_PATH)
      });
      events.set(symbol, matches);
    }
  }
  return events;
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

let lookup: { expiresAt: number; data: Promise<ReadonlyMap<string, NseCorporateEvent[]>> } | undefined;
export function getNseEvents(): Promise<ReadonlyMap<string, NseCorporateEvent[]>> {
  if (lookup && lookup.expiresAt > Date.now()) return lookup.data;
  const state = {
    expiresAt: Date.now() + 60_000,
    data: Promise.all([
      readNsePublicReport(MEETINGS_PATH).then((payload) => parseNseEvents(payload, 'earnings')),
      readNsePublicReport(ACTIONS_PATH).then((payload) => parseNseEvents(payload, 'action')),
      readNsePublicReport(FILINGS_PATH)
    ]).then(([earnings, actions, filings]) => {
      attachResultsFilings(earnings, filings);
      const combined = new Map<string, NseCorporateEvent[]>(earnings);
      for (const [symbol, items] of actions)
        combined.set(symbol, [...(combined.get(symbol) ?? []), ...items]);
      for (const events of combined.values()) events.sort((a, b) => a.day.localeCompare(b.day));
      if (earnings.size && actions.size) state.expiresAt = Date.now() + 15 * 60_000;
      return combined;
    })
  };
  lookup = state;
  return state.data;
}

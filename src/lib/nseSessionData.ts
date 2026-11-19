import { parseCSV } from './csv';
import type { OHLCV } from './indicators';
import { readBoundedReport } from './nsePublicReports';
import { CASH_SPECIAL_SESSIONS, cashSessionLimits, dateToISTString, latestCompletedSession, sessionTime } from './timezone';

const ARCHIVE = 'https://archives.nseindia.com';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export interface ExchangeClose {
  candle: OHLCV;
  previousClose?: number;
}
function reportDate(day: string) {
  const [year, month, date] = day.split('-');
  return {
    file: date + month + year,
    cash: [date, MONTHS[Number(month) - 1], year].join('-'),
    index: [date, month, year].join('-')
  };
}
function validRow(bar: OHLCV) {
  return (
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) &&
    bar.low > 0 &&
    bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}
function readRows(csv: string) {
  const [header, ...rows] = parseCSV(csv);
  return { headers: header?.map((key) => key.trim().replace(/^\uFEFF/, '')) ?? [], rows };
}
export function parseCashSession(csv: string, day: string): Map<string, ExchangeClose> {
  const { headers, rows } = readRows(csv);
  const columns = [
    'SYMBOL',
    'SERIES',
    'DATE1',
    'PREV_CLOSE',
    'OPEN_PRICE',
    'HIGH_PRICE',
    'LOW_PRICE',
    'CLOSE_PRICE',
    'TTL_TRD_QNTY'
  ];
  const indices = columns.map((key) => headers.indexOf(key));
  if (indices.some((index) => index < 0)) return new Map();
  const result = new Map<string, ExchangeClose>();
  const duplicate = new Set<string>();
  for (const row of rows) {
    const [symbol, series, date, previous, open, high, low, close, volume] = indices.map((i) =>
      row[i]?.trim()
    );
    if (
      series !== 'EQ' ||
      date !== reportDate(day).cash ||
      !symbol ||
      !/^[A-Z0-9&-]{1,25}$/.test(symbol)
    )
      continue;
    if (!open || !high || !low || !close || !volume) continue;
    const key = symbol + '.NS',
      previousClose = Number(previous);
    const candle = {
      date: sessionTime(day, cashSessionLimits(day).continuousStart),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume)
    };
    if (!validRow(candle) || !Number.isFinite(previousClose) || previousClose <= 0 || candle.volume <= 0)
      continue;
    if (result.has(key)) duplicate.add(key);
    result.set(key, { candle, previousClose });
  }
  for (const key of duplicate) result.delete(key);
  return result;
}
export function parseIndexSession(csv: string, day: string): Map<string, ExchangeClose> {
  const { headers, rows } = readRows(csv);
  const columns = [
    'Index Name',
    'Index Date',
    'Open Index Value',
    'High Index Value',
    'Low Index Value',
    'Closing Index Value',
    'Volume'
  ];
  const indices = columns.map((key) => headers.indexOf(key));
  if (indices.some((index) => index < 0)) return new Map();
  const result = new Map<string, ExchangeClose>();
  const duplicate = new Set<string>();
  for (const row of rows) {
    const [name, date, open, high, low, close, volume] = indices.map((i) => row[i]?.trim());
    const key = name === 'Nifty 50' ? '^NSEI' : name === 'India VIX' ? '^INDIAVIX' : name?.startsWith('Nifty ') ? name : null;
    if (!key || date !== reportDate(day).index || !open || !high || !low || !close) continue;
    const candle = {
      date: sessionTime(day, cashSessionLimits(day).continuousStart),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: volume === '-' ? 0 : Number(volume)
    };
    if (validRow(candle)) {
      if (result.has(key)) duplicate.add(key);
      result.set(key, { candle });
    }
  }
  for (const key of duplicate) result.delete(key);
  return result;
}
const reports = new Map<string, { expiresAt: number; promise: Promise<Map<string, ExchangeClose>> }>();
function readSession(kind: 'cash' | 'index', day: string | null) {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Promise.resolve(new Map<string, ExchangeClose>());
  const key = kind + ':' + day,
    existing = reports.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const filename = reportDate(day).file;
  const url =
    kind === 'cash'
      ? ARCHIVE + '/products/content/sec_bhavdata_full_' + filename + '.csv'
      : ARCHIVE + '/content/indices/ind_close_all_' + filename + '.csv';
  const state: { expiresAt: number; promise: Promise<Map<string, ExchangeClose>> } = {
    expiresAt: Date.now() + 120000,
    promise: Promise.resolve().then(async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const csv = await readBoundedReport(response,2_000_000);
        if (!csv) return new Map<string, ExchangeClose>();
        const data = kind === 'cash' ? parseCashSession(csv, day) : parseIndexSession(csv, day);
        if (kind === 'cash' && data.size < 500) return new Map<string, ExchangeClose>();
        if (data.size) state.expiresAt = Date.now() + 6 * 3600000;
        return data;
      } catch {
        return new Map<string, ExchangeClose>();
      }
    })
  };
  reports.set(key, state);
  if (reports.size > 10)
    for (const [old, entry] of reports) if (entry.expiresAt < Date.now()) reports.delete(old);
  return state.promise;
}
export const getCashSession = (day: string | null) => readSession('cash', day);
export const getIndexSession = (day: string | null) => readSession('index', day);

export async function restoreCashSpecialSessions(symbol: string, history: OHLCV[]) {
  if (history.length < 2 || !symbol.endsWith('.NS')) return history;
  const days = new Set(history.map(bar => dateToISTString(new Date(bar.date))));
  const from = dateToISTString(new Date(history[0].date));
  const through = dateToISTString(new Date(history[history.length - 1].date));
  const missing = CASH_SPECIAL_SESSIONS.filter(day => day > from && day < through && !days.has(day));
  const reports = await Promise.all(missing.map(day => getCashSession(day)));
  return missing.reduce((bars, day, index) => {
    const row = reports[index].get(symbol);
    if (!row) return bars;
    const restored = { ...row, candle: { ...row.candle, restoredFromNse: true } };
    return mergeExchangeClose(bars,restored,day) ?? bars;
  }, history);
}

export function completedCloseTime(day: string, casEligible: boolean | null = null) {
  return sessionTime(day, cashSessionLimits(day, casEligible).finalClose);
}

// The prior-close check avoids joining an unadjusted exchange bar onto a
// differently adjusted Yahoo history after a split, bonus or symbol change.
export function mergeExchangeClose(
  history: OHLCV[],
  official: ExchangeClose,
  day: string
): OHLCV[] | null {
  if (official.candle.splitReported || history.some(bar =>
      bar.splitReported && dateToISTString(new Date(bar.date)) === day)) return null;
  const previousDay = latestCompletedSession(sessionTime(day, cashSessionLimits(day).preOpenStart));
  const earlier = history.filter((bar) => dateToISTString(new Date(bar.date)) < day);
  const prior = earlier.at(-1);
  if (!previousDay || !prior || dateToISTString(new Date(prior.date)) !== previousDay) return null;
  if (official.previousClose != null && Math.abs(prior.close / official.previousClose - 1) > 0.005)
    return null;
  return [
    ...earlier,
    official.candle,
    ...history.filter((bar) => dateToISTString(new Date(bar.date)) > day)
  ];
}

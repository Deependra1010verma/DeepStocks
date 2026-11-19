import YahooFinance from "yahoo-finance2";
import { XMLParser } from "fast-xml-parser";
import { OHLCV } from "./indicators";
import { connectDB } from "./db";
import { StockCache } from "./models/StockCache";
import { todayIST, dateToISTString, getMarketSession, isContinuous15mBar, latestCompletedSession, shiftDate, isCompletedMarketPeriod, cashSessionLimits, sessionTime } from "./timezone";
import { comparableAnnualPeriods, type AnnualFinancials } from './fundamentalQuality';
import { assessDataQuality, type DataQuality } from './dataQuality';
import { beforeDeadline } from './deadline';
import { completedCloseTime, getCashSession, mergeExchangeClose, restoreCashSpecialSessions } from './nseSessionData';
import { isBtstWindow } from './entrySignals';
import type { SectorBenchmark } from './sectorBenchmarks';

// Suppress the deprecated historical() notice — we use chart() directly now
const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });
const CANDLE_CACHE_TTL_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const DAILY_HISTORY_VERSION = 4;
const FUNDAMENTALS_VERSION = 2;
const CANDLE_HISTORY_DAYS = { '1d': 1750, '1wk': 1900, '1mo': 1900, '15m': 35 };
interface CandleSeries {
  candles: OHLCV[];
  splitDays: string[];
}
const candleMemoryCache = new Map<string, { series: CandleSeries; expiresAt: number }>();
const candleInFlight = new Map<string, Promise<CandleSeries>>();
const eventCache = new Map<string, { value: CorporateEventRisk; expires: number }>();
let yahooWarmup: Promise<void> | null = null;
let candleWritesInFlight = 0;

export interface FundamentalData {
  evidenceVersion?: number;
  eventStatus?: 'known' | 'unknown';
  asOf?: string;
  qualityHistoryStatus?: 'verified' | 'unavailable';
  annualHistory?: AnnualFinancials[];
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  profitMargins: number | null;
  forwardPE: number | null;
  marketCap: number | null;
  earningsDate: string | null;
  corporateEventDate: string | null;
  corporateEventType: string | null;
  source: "quoteSummary" | "quote" | "unavailable";
}

export interface StockData {
  dataQuality?: DataQuality;
  intradayVolumeNote?: string;
  symbol: string;
  sector?: string;
  sectorBenchmark?: SectorBenchmark;
  candles: OHLCV[];
  weeklyCandles?: OHLCV[];
  monthlyCandles?: OHLCV[];
  confirmationCandles?: OHLCV[];
  fundamentals: FundamentalData;
  currentPrice: number;
  dayChange: number;
  dayChangePercent: number;
  volume: number;
  quoteVolume?: number | null;
  averageDailyVolume: number | null;
  name: string;
}

export interface NewsItem {
  title: string;
  pubDate: string;
  link: string;
}

const EMPTY_FUNDAMENTALS: FundamentalData = {
  revenueGrowth: null,
  earningsGrowth: null,
  returnOnEquity: null,
  debtToEquity: null,
  profitMargins: null,
  forwardPE: null,
  marketCap: null,
  earningsDate: null,
  corporateEventDate: null,
  corporateEventType: null,
  source: "unavailable",
};

async function fetchWithRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 400, timeoutMs = 8000): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      return await beforeDeadline(fn, Date.now() + timeoutMs);
    } catch {
      if (i === retries - 1) return null;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  return null;
}

function toEventDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>;
    return toEventDate(raw.raw ?? raw.timestamp ?? raw.fmt ?? raw.date);
  }
  return null;
}

function firstEventDate(value: unknown): Date | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const date = toEventDate(item);
      if (date) return date;
    }
    return null;
  }
  return toEventDate(value);
}

export function parseCalendarEvents(result: unknown) {
  const calendar = (result as Record<string, unknown> | null)?.calendarEvents as Record<string, unknown> | undefined;
  const nested = calendar?.earnings as Record<string, unknown> | undefined;
  const earnings = firstEventDate(nested?.earningsDate ?? calendar?.earningsDate);
  const exDividend = firstEventDate(calendar?.exDividendDate);
  const dividend = firstEventDate(calendar?.dividendDate);
  const corporate = exDividend ?? dividend;
  return {
    earningsDate: earnings?.toISOString() ?? null,
    corporateEventDate: corporate?.toISOString() ?? null,
    corporateEventType: exDividend ? "Ex-dividend" : dividend ? "Dividend" : null,
    eventStatus: earnings && earnings.getTime() >= new Date(`${todayIST()}T00:00:00+05:30`).getTime() ? 'known' as const : 'unknown' as const,
  };
}

async function fetchHistoricalCandlesUncached(
  symbol: string,
  interval: "1d" | "1wk" | "1mo" | "15m",
  period1: Date
): Promise<CandleSeries> {
  const now = new Date();
  const result = await fetchWithRetry(() =>
    yahooFinance.chart(symbol, { period1, period2: now, interval, events: 'split' }, { fetchOptions: { signal: AbortSignal.timeout(8000) } })
  );
  if (!result) return { candles:[], splitDays:[] };
  const lastTrade = result.meta?.regularMarketTime;
  const cutoff = getMarketSession(now, false).state === 'LIVE' && lastTrade && Number.isFinite(+lastTrade)
    ? Math.min(+now, +lastTrade) : +now;
  const splitDays = new Set((result.events?.splits ?? []).map(event => dateToISTString(new Date(event.date))));
  const candles = (result.quotes ?? [])
    .filter(q => (interval !== '15m' || +q.date + FIFTEEN_MINUTES_MS <= cutoff) &&
      q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
    .map((q) => ({
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume!,
      date: new Date(q.date),
      ...(splitDays.has(dateToISTString(new Date(q.date)))?{splitReported:true}:{}),
    }));
  return { candles, splitDays: [...splitDays] };
}

function closePhase(at: Date) {
  return `${latestCompletedSession(at, false)}:${latestCompletedSession(at)}`;
}

export async function fetchHistoricalCandles(
  symbol: string,
  interval: "1d" | "1wk" | "1mo" | "15m" = "1d",
  period1?: Date
): Promise<OHLCV[]> {
  return (await fetchHistoricalCandleSeries(symbol, interval, period1)).candles;
}

export async function fetchHistoricalCandleSeries(
  symbol: string,
  interval: "1d" | "1wk" | "1mo" | "15m" = "1d",
  period1?: Date
): Promise<CandleSeries> {
  const start = period1 ?? new Date(`${dateToISTString(new Date(Date.now() - CANDLE_HISTORY_DAYS[interval] * 86400000))}T00:00:00+05:30`);
  const key = `${symbol}:${interval}:${start.toISOString()}:${interval === '15m' ? '' : closePhase(new Date())}`;
  const cached = candleMemoryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return {
    candles: cached.series.candles.map(candle => ({...candle})), splitDays: [...cached.series.splitDays]
  };
  const running = candleInFlight.get(key);
  if (running) return running;

  const requestedAt = Date.now();
  const request = fetchHistoricalCandlesUncached(symbol, interval, start)
    .then(async ({candles, splitDays}) => {
      const valid = [...new Map(candles.filter(c => [c.open, c.high, c.low, c.close, c.volume, new Date(c.date).getTime()].every(Number.isFinite) && +new Date(c.date) <= Date.now() + 60000 && c.low > 0 && c.volume >= 0 && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)).map(c => [new Date(c.date).getTime(), c])).values()].sort((a, b) => +new Date(a.date) - +new Date(b.date));
      const history = interval === '1d' ? await restoreCashSpecialSessions(symbol,valid) : valid;
      const series = {candles:history, splitDays};
      if (candleMemoryCache.size > 1000) for (const [k, v] of candleMemoryCache) if (v.expiresAt <= Date.now()) candleMemoryCache.delete(k);
      if (history.length > 0 || splitDays.length > 0) {
        const now = Date.now();
        const day = dateToISTString(new Date(requestedAt));
        const sessionOpen = +sessionTime(day, cashSessionLimits(day).continuousStart);
        const expiresAt = interval === '15m'
          ? Math.min(now + CANDLE_CACHE_TTL_MS, sessionOpen + (Math.floor((requestedAt - sessionOpen) / FIFTEEN_MINUTES_MS) + 1) * FIFTEEN_MINUTES_MS)
          : now + CANDLE_CACHE_TTL_MS;
        candleMemoryCache.set(key, { series, expiresAt });
      }
      return series;
    })
    .finally(() => candleInFlight.delete(key));
  candleInFlight.set(key, request);
  return request;
}

async function warmUpYahoo() {
  if (!yahooWarmup) {
    yahooWarmup = fetchWithRetry(() => yahooFinance.quote("^NSEI", {}, { fetchOptions: { signal: AbortSignal.timeout(2000) } }), 1, 400, 2200).then((result) => { if (!result) yahooWarmup = null; });
  }
  await yahooWarmup;
}

export async function fetchFundamentals(symbol: string): Promise<FundamentalData> {
  const [result, quote, annual] = await Promise.all([
    fetchWithRetry(() =>
    yahooFinance.quoteSummary(symbol, { modules: ["financialData", "defaultKeyStatistics", "calendarEvents"] }, { fetchOptions: { signal: AbortSignal.timeout(8000) } })
    ),
    fetchQuote(symbol),
    fetchWithRetry(() => yahooFinance.fundamentalsTimeSeries(symbol, { period1: new Date(Date.now() - 5 * 365 * 86400000), type: 'annual', module: 'all' }, { fetchOptions: { signal: AbortSignal.timeout(8000) } }), 1),
  ]);
  const fd = result?.financialData;
  const dks = result?.defaultKeyStatistics;
  const q = (quote ?? {}) as Record<string, unknown>;
  const numberFrom = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? value : null;
  };

  if (!result && !quote) return { ...EMPTY_FUNDAMENTALS };
  const events = parseCalendarEvents(result);
  // Yahoo supplies period end and period type here. Filing publication and
  // point-in-time availability cannot be inferred from either field.
  const annualHistory: AnnualFinancials[] = (annual ?? []).map(item => {
    const periodEnd = new Date(item.date);
    const financials = item as unknown as Record<string, unknown>;
    return {
      date: item.periodType === '12M' && Number.isFinite(+periodEnd) ? periodEnd.toISOString().slice(0, 10) : '',
      revenue: numberFrom(financials.totalRevenue), profit: numberFrom(financials.netIncome),
      operatingCashFlow: numberFrom(financials.operatingCashFlow), debt: numberFrom(financials.totalDebt),
      equity: numberFrom(financials.stockholdersEquity), shares: numberFrom(financials.ordinarySharesNumber)
    };
  });
  const now = new Date();
  const {years} = comparableAnnualPeriods(annualHistory, now);
  return {
    revenueGrowth: numberFrom(fd?.revenueGrowth, q.revenueGrowth),
    earningsGrowth: numberFrom(fd?.earningsGrowth, q.earningsGrowth),
    returnOnEquity: numberFrom(fd?.returnOnEquity, q.returnOnEquity),
    debtToEquity: numberFrom(fd?.debtToEquity, q.debtToEquity),
    profitMargins: numberFrom(fd?.profitMargins, q.profitMargins),
    forwardPE: numberFrom(dks?.forwardPE,q.forwardPE),
    marketCap: numberFrom(q.marketCap),
    ...events,
    asOf: now.toISOString(),
    evidenceVersion: FUNDAMENTALS_VERSION,
    qualityHistoryStatus: years?.every(row => [row.revenue,row.profit,row.operatingCashFlow,row.debt,row.equity,row.shares].every(Number.isFinite)) ? 'verified' : 'unavailable',
    annualHistory,
    source: result ? "quoteSummary" : "quote",
  };
}

export interface CorporateEventRisk {
  eventStatus?: 'known' | 'unknown';
  earningsDate: string | null;
  corporateEventDate: string | null;
  corporateEventType: string | null;
}

/** Lightweight calendar lookup used for swing/BTST candidates only. */
export async function fetchCorporateEventRisk(symbol: string): Promise<CorporateEventRisk> {
  const cached = eventCache.get(symbol);
  if (cached && cached.expires > Date.now()) return cached.value;
  const result = await fetchWithRetry(() =>
    yahooFinance.quoteSummary(symbol, { modules: ["calendarEvents"] }, { fetchOptions: { signal: AbortSignal.timeout(6000) } })
  );
  const value: CorporateEventRisk = result ? parseCalendarEvents(result) : {
    earningsDate: null,
    corporateEventDate: null,
    corporateEventType: null,
    eventStatus: 'unknown',
  };
  eventCache.set(symbol, { value, expires: Date.now() + (value.eventStatus === 'known' ? 3600000 : 60000) });
  return value;
}

export async function fetchQuote(symbol: string) {
  return fetchWithRetry(() => yahooFinance.quote(symbol, {}, { fetchOptions: { signal: AbortSignal.timeout(8000) } }));
}

export async function fetchNews(symbol: string): Promise<NewsItem[]> {
  const ticker = symbol.replace(".NS", "");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(ticker + " NSE stock India")}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.map((item: Record<string, string>) => ({
      title: item.title ?? "",
      pubDate: item.pubDate ?? "",
      link: item.link ?? "",
    })).filter((item: NewsItem) => Number.isFinite(Date.parse(item.pubDate)) && Date.parse(item.pubDate) <= Date.now() && Date.now() - Date.parse(item.pubDate) < 7 * 86400000 && /^https:\/\//.test(item.link)).slice(0, 5);
  } catch {
    return [];
  }
}

export interface BatchCoverage { attempted: string[]; failed: string[]; deferred: string[] }
export type StockDataBatch = Map<string, StockData> & { coverage: BatchCoverage };

export async function batchFetchStockData(
  symbols: string[],
  interval: "1d" | "1wk" | "1mo" | "15m" = "1d",
  withFundamentals = false,
  withWeekly = false,
  deadline = Date.now() + 25000,
  signal?: AbortSignal,
  options: {
    withBtstConfirmation?: boolean;
    sessionInstruments?: Promise<ReadonlyMap<string, { casEligible: boolean }>>;
    historicalCasEligibility?: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
  } = {},
): Promise<StockDataBatch> {
  const results = Object.assign(new Map<string, StockData>(), { coverage: { attempted: [], failed: [], deferred: [] } as BatchCoverage });
  const unique = [...new Set(symbols)], attempted = new Set<string>();
  const today = todayIST();
  const startedAt = new Date();
  const instruments = options.sessionInstruments?.catch(() => undefined);
  const confirmationStart=new Date(shiftDate(today,-2)+'T09:15:00+05:30');
  const alive = () => !signal?.aborted && Date.now() < deadline;
  await beforeDeadline(() => warmUpYahoo(), Math.min(deadline, Date.now() + 2500), signal).catch(() => undefined);
  let dbAvailable = false;
  if (interval === '1d' && alive()) {
    try { await beforeDeadline(() => connectDB(), Math.min(deadline, Date.now() + 3000), signal); dbAvailable = true; } catch { /* Live provider remains bounded. */ }
  }
  let cursor = 0;
  async function worker() {
    while (alive() && Date.now() < deadline - 500 && cursor < unique.length) {
      const symbol = unique[cursor++];
      attempted.add(symbol);
      const symbolDeadline = Math.min(deadline, Date.now() + 12000);
      try {
        let cachedCandles: OHLCV[] | null = null;
        let cachedFundamentals: FundamentalData | null = null;
        if (dbAvailable) {
          try {
            const cached = await beforeDeadline(() => StockCache.findOne({ symbol, date: today }).maxTimeMS(700).lean<{candles?: OHLCV[]; fundamentals?: FundamentalData; updatedAt?: Date; historyVersion?: number}>(), Math.min(symbolDeadline, Date.now() + 900), signal);
            const fresh = cached?.updatedAt && Date.now() - +new Date(cached.updatedAt) < CANDLE_CACHE_TTL_MS;
            if (fresh && cached?.updatedAt && closePhase(new Date(cached.updatedAt)) === closePhase(startedAt) &&
                cached.historyVersion === DAILY_HISTORY_VERSION && cached.candles && cached.candles.length >= 20) {
              cachedCandles = cached.candles.map(c => ({ ...c, date: new Date(c.date) }));
            }
            if (fresh && cached?.fundamentals?.evidenceVersion === FUNDAMENTALS_VERSION && cached.fundamentals.asOf &&
                Date.now() - Date.parse(cached.fundamentals.asOf) < CANDLE_CACHE_TTL_MS) cachedFundamentals = cached.fundamentals;
          } catch { /* A cache miss must not block the entire scan. */ }
        }
        const confirmationRequest = options.withBtstConfirmation
          ? Promise.resolve(instruments).then(master => {
            const cas = master?.get(symbol)?.casEligible ?? null;
            return isBtstWindow(startedAt, cas) ? fetchHistoricalCandles(symbol, '15m', confirmationStart) : [];
          }) : [];
        const [candles, quote, fundamentals, weekly, monthly, confirmation, sessionInstruments] = await beforeDeadline(() => Promise.all([
          cachedCandles ? Promise.resolve(cachedCandles) : fetchHistoricalCandles(symbol, interval),
          fetchQuote(symbol),
          withFundamentals ? cachedFundamentals ? Promise.resolve(cachedFundamentals) : fetchFundamentals(symbol) : Promise.resolve({ ...EMPTY_FUNDAMENTALS }),
          withWeekly ? fetchHistoricalCandles(symbol, '1wk') : Promise.resolve([]),
          withFundamentals ? fetchHistoricalCandles(symbol, '1mo') : Promise.resolve([]),
          confirmationRequest,
          instruments,
        ]), symbolDeadline, signal);
        if (!alive() || candles.length < 20) continue;
        const now = new Date();
        const date = dateToISTString(now);
        const historical = options.historicalCasEligibility?.get(symbol);
        const casForDay = (day: string) => (day === today ? sessionInstruments?.get(symbol)?.casEligible : undefined) ?? historical?.get(day) ?? null;
        const cas = casForDay(date);
        const exchangeSession = getMarketSession(now, cas);
        const completedDay = latestCompletedSession(now, cas);
        const quoteDay = quote?.regularMarketTime ? dateToISTString(new Date(quote.regularMarketTime)) : date;
        const evidenceDay = exchangeSession.state === 'LIVE' || exchangeSession.state === 'UNKNOWN' ? date : completedDay ?? quoteDay;
        const evidenceCas = casForDay(evidenceDay);
        const eligibility = evidenceCas === null ? undefined : { day: evidenceDay, casEligible: evidenceCas };
        const delay = typeof quote?.exchangeDataDelayedBy === 'number' ? quote.exchangeDataDelayedBy : null;
        let usableCandles = candles;
        let intradayVolumeNote: string | undefined;
        if (interval === '15m') {
          const intradayCutoff = exchangeSession.state === 'LIVE' && quote?.regularMarketTime
            ? Math.min(+now, +new Date(quote.regularMarketTime)) : +now;
          let unverifiedHistoricalSlots = false;
          usableCandles = candles.filter(candle => {
            const at = new Date(candle.date);
            if (+at + FIFTEEN_MINUTES_MS > intradayCutoff) return false;
            const day = dateToISTString(at), datedCas = casForDay(day);
            const valid = isContinuous15mBar(at, datedCas);
            if (day < quoteDay && datedCas === null && !valid && isContinuous15mBar(at, false)) unverifiedHistoricalSlots = true;
            return valid;
          });
          if (unverifiedHistoricalSlots && usableCandles.some(bar => dateToISTString(bar.date) === quoteDay &&
              isContinuous15mBar(bar.date, false) && !isContinuous15mBar(bar.date))) {
            intradayVolumeNote = 'Comparable closing-slot RVOL requires dated historical CAS eligibility';
          }
        }
        const hasCompletedBar=(bars:OHLCV[])=>!!completedDay&&bars.some(
          bar=>dateToISTString(new Date(bar.date))===completedDay
        );
        let exchangeClose, candleSource:DataQuality['candleSource']='Yahoo';
        let mergedOfficial = false;
        const closed = exchangeSession.state === 'CLOSED' || exchangeSession.state === 'PRE_OPEN';
        const crossedClose = interval === '1d' && completedDay === date && latestCompletedSession(startedAt, cas) !== completedDay;
        let quality = assessDataQuality(quote?.regularMarketTime ?? null, usableCandles.at(-1)?.date ?? null, delay, interval === '15m', now, eligibility);
        if(interval==='1d'&&completedDay&&exchangeSession.calendarVerified&&(!hasCompletedBar(candles)||(closed&&(quality.stale||crossedClose)))) {
          const report=await beforeDeadline(()=>getCashSession(completedDay),Math.min(deadline,Date.now()+5200),signal).catch(()=>null);
          const row=report?.get(symbol);
          const merged=row&&mergeExchangeClose(candles,row,completedDay);
          if(merged&&row){
            mergedOfficial = true;
            usableCandles=merged;
            if(dateToISTString(new Date(merged.at(-1)!.date))===completedDay)candleSource='NSE EOD';
            if(closed)exchangeClose=row;
          }
        }
        if(!alive()||(!quote&&!exchangeClose))continue;
        if (usableCandles.length < 20) continue;
        const completedWeekly = weekly.filter(c => isCompletedMarketPeriod(c.date, '1wk', startedAt));
        const dayChange=exchangeClose?exchangeClose.candle.close-exchangeClose.previousClose!:(quote?.regularMarketChange??0);
        if (mergedOfficial) {
          quality = assessDataQuality(
            exchangeClose && completedDay ? completedCloseTime(completedDay, evidenceCas) : quote?.regularMarketTime ?? null,
            usableCandles.at(-1)?.date ?? null, exchangeClose ? 0 : delay, false, now, eligibility
          );
        }
        if(interval==='1d'&&completedDay&&!hasCompletedBar(usableCandles)) {
          quality.stale=true;
          quality.issues.push('Latest completed daily candle unavailable');
        }
        if (crossedClose && !mergedOfficial) {
          quality.stale = true;
          quality.issues.push('Daily history request crossed the close without a verified final candle');
        }
        const restoredCashSessions = usableCandles.filter(bar=>bar.restoredFromNse).map(bar=>dateToISTString(new Date(bar.date)));
        results.set(symbol, {
          symbol, candles: usableCandles, weeklyCandles: withWeekly ? completedWeekly : undefined,
          confirmationCandles: options.withBtstConfirmation ? confirmation : undefined,
          monthlyCandles: monthly.filter(c => isCompletedMarketPeriod(c.date, '1mo', startedAt)),
          ...(intradayVolumeNote ? { intradayVolumeNote } : {}),
          dataQuality: {...quality,quoteSource:exchangeClose?'NSE EOD':'Yahoo',candleSource,
            ...(restoredCashSessions.length ? { restoredCashSessions } : {}) },
          fundamentals, currentPrice: exchangeClose?.candle.close ?? quote?.regularMarketPrice ?? usableCandles.at(-1)!.close,
          dayChange, dayChangePercent: exchangeClose?dayChange/exchangeClose.previousClose!*100:quote?.regularMarketChangePercent??0,
          volume: interval === '15m' ? usableCandles.at(-1)!.volume : exchangeClose?.candle.volume??quote?.regularMarketVolume ?? usableCandles.at(-1)!.volume,
          ...(interval === '1d' ? { quoteVolume: exchangeClose?.candle.volume ?? quote?.regularMarketVolume ?? null } : {}),
          averageDailyVolume: quote?.averageDailyVolume3Month ?? quote?.averageDailyVolume10Day ?? null,
          name: quote?.longName ?? quote?.shortName ?? symbol,
        });
        if (dbAvailable && candleWritesInFlight < 2 && alive() && Date.now() < deadline - 1000 && (!cachedCandles || (withFundamentals && !cachedFundamentals))) {
          // A timed-out waiter does not stop a Mongo write. Hold the slot until
          // the real write settles, so optional caches cannot flood the pool
          // needed to save progress and release the scan lease.
          candleWritesInFlight++;
          const write = Promise.resolve().then(() => StockCache.updateOne({ symbol, date: today }, { $set: { symbol, date: today, candles, historyVersion: DAILY_HISTORY_VERSION, ...(withFundamentals ? { fundamentals } : {}), updatedAt: startedAt } }, { upsert: true, maxTimeMS: 700, strict: false })).finally(() => { candleWritesInFlight--; });
          await beforeDeadline(() => write, Math.min(deadline, Date.now() + 900), signal).catch(() => undefined);
        }
      } catch { /* Count this attempted symbol as failed, then continue if time remains. */ }
    }
  }
  // Stock-level concurrency is bounded in addition to the SDK's HTTP queue.
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, () => worker()));
  results.coverage = { attempted: [...attempted], failed: [...attempted].filter(s => !results.has(s)), deferred: unique.filter(s => !attempted.has(s)) };
  return results;
}

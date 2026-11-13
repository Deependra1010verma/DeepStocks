import YahooFinance from "yahoo-finance2";
import { XMLParser } from "fast-xml-parser";
import { OHLCV } from "./indicators";
import { connectDB } from "./db";
import { StockCache } from "./models/StockCache";
import { todayIST } from "./timezone";

// Suppress the deprecated historical() notice — we use chart() directly now
const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical"] });

export interface FundamentalData {
  revenueGrowth: number | null;
  earningsGrowth: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  profitMargins: number | null;
  forwardPE: number | null;
  marketCap: number | null;
  source: "quoteSummary" | "quote" | "unavailable";
}

export interface StockData {
  symbol: string;
  sector?: string;
  candles: OHLCV[];
  weeklyCandles?: OHLCV[];
  fundamentals: FundamentalData;
  currentPrice: number;
  dayChange: number;
  dayChangePercent: number;
  volume: number;
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
  source: "unavailable",
};

async function fetchWithRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch {
      if (i === retries - 1) return null;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  return null;
}

export async function fetchHistoricalCandles(
  symbol: string,
  interval: "1d" | "1wk" | "15m" = "1d",
  period1?: Date
): Promise<OHLCV[]> {
  const now = new Date();
  // period2 must always be set — yahoo-finance2 v4 requires it
  const period2 = now;

  if (interval === "15m") {
    // 15m: last 5 trading days
    const startDate = period1 || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await fetchWithRetry(() =>
      yahooFinance.chart(symbol, { period1: startDate, period2, interval: "15m" })
    );
    if (!result?.quotes) return [];
    return result.quotes
      .filter(
        (q) =>
          q.open != null &&
          q.high != null &&
          q.low != null &&
          q.close != null &&
          q.volume != null
      )
      .map((q) => ({
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
        date: new Date(q.date),
      }));
  }

  // Daily / weekly: last 400 days (need 200 for EMA200)
  const startDate = period1 || new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const result = await fetchWithRetry(() =>
    yahooFinance.chart(symbol, { period1: startDate, period2, interval })
  );
  if (!result?.quotes) return [];
  return result.quotes
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
    .map((q) => ({
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume!,
      date: new Date(q.date),
    }));
}

export async function fetchFundamentals(symbol: string): Promise<FundamentalData> {
  const [result, quote] = await Promise.all([
    fetchWithRetry(() =>
    yahooFinance.quoteSummary(symbol, { modules: ["financialData", "defaultKeyStatistics"] })
    ),
    fetchQuote(symbol),
  ]);
  const fd = result?.financialData;
  const dks = result?.defaultKeyStatistics;
  const q = (quote ?? {}) as Record<string, unknown>;
  const numberFrom = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
    return typeof value === "number" ? value : null;
  };

  if (!result && !quote) return { ...EMPTY_FUNDAMENTALS };
  return {
    revenueGrowth: fd?.revenueGrowth ?? numberFrom(q.revenueGrowth),
    earningsGrowth: fd?.earningsGrowth ?? numberFrom(q.earningsGrowth),
    returnOnEquity: fd?.returnOnEquity ?? numberFrom(q.returnOnEquity),
    debtToEquity: fd?.debtToEquity ?? numberFrom(q.debtToEquity),
    profitMargins: fd?.profitMargins ?? numberFrom(q.profitMargins),
    forwardPE: (dks?.forwardPE as number | null | undefined) ?? numberFrom(q.forwardPE, q.trailingPE),
    marketCap: numberFrom(q.marketCap),
    source: result ? "quoteSummary" : "quote",
  };
}

export async function fetchQuote(symbol: string) {
  return fetchWithRetry(() => yahooFinance.quote(symbol));
}

export async function fetchNews(symbol: string): Promise<NewsItem[]> {
  const ticker = symbol.replace(".NS", "");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(ticker + " NSE stock India")}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const items = parsed?.rss?.channel?.item ?? [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 5).map((item: Record<string, string>) => ({
      title: item.title ?? "",
      pubDate: item.pubDate ?? "",
      link: item.link ?? "",
    }));
  } catch {
    return [];
  }
}

export async function batchFetchStockData(
  symbols: string[],
  interval: "1d" | "1wk" | "15m" = "1d",
  withFundamentals = false,
  withWeekly = false,
): Promise<Map<string, StockData>> {
  const results = new Map<string, StockData>();
  // Yahoo is network-bound; 20-way chunks keep a broad NSE universe responsive
  // while avoiding one failed symbol cancelling the whole batch.
  const CONCURRENCY = 20;
  const today = todayIST();

  let dbAvailable = false;
  if (interval === "1d") {
    try {
      await connectDB();
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  }

  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const chunk = symbols.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      chunk.map(async (symbol) => {
        let candles: OHLCV[] | null = null;
        let fundamentals: FundamentalData | null = null;
        let cacheHitCandles = false;
        let cacheHitFundamentals = false;

        if (dbAvailable && interval === "1d") {
          try {
            const cached = await StockCache.findOne({ symbol, date: today }).lean<{
              candles?: OHLCV[];
              fundamentals?: FundamentalData;
            }>();
            if (cached?.candles && cached.candles.length >= 20) {
              candles = cached.candles.map((c) => ({
                ...c,
                date: new Date(c.date),
              }));
              cacheHitCandles = true;
            }
            if (
              withFundamentals &&
              cached?.fundamentals &&
              Object.values(cached.fundamentals).some((v) => v !== null)
            ) {
              fundamentals = cached.fundamentals;
              cacheHitFundamentals = true;
            }
          } catch {
            // Fall back to live Yahoo Finance fetch
          }
        }

        const [fetchedCandles, quote, fetchedFundamentals, weeklyCandles] = await Promise.all([
          cacheHitCandles ? Promise.resolve(candles!) : fetchHistoricalCandles(symbol, interval),
          fetchQuote(symbol),
          withFundamentals
            ? cacheHitFundamentals
              ? Promise.resolve(fundamentals!)
              : fetchFundamentals(symbol)
            : Promise.resolve({ ...EMPTY_FUNDAMENTALS }),
          withWeekly ? fetchHistoricalCandles(symbol, "1wk") : Promise.resolve([]),
        ]);

        if (fetchedCandles.length < 20 || !quote) return;

        if (
          dbAvailable &&
          interval === "1d" &&
          (!cacheHitCandles || (withFundamentals && !cacheHitFundamentals))
        ) {
          try {
            await StockCache.updateOne(
              { symbol, date: today },
              {
                $set: {
                  symbol,
                  date: today,
                  candles: fetchedCandles,
                  fundamentals: fetchedFundamentals,
                  updatedAt: new Date(),
                },
              },
              { upsert: true }
            );
          } catch {
            // Non-fatal cache write failure
          }
        }

        results.set(symbol, {
          symbol,
          sector: undefined,
          candles: fetchedCandles,
          weeklyCandles: withWeekly ? weeklyCandles : undefined,
          fundamentals: fetchedFundamentals,
          currentPrice: (quote.regularMarketPrice as number) ?? fetchedCandles[fetchedCandles.length - 1].close,
          dayChange: (quote.regularMarketChange as number) ?? 0,
          dayChangePercent: (quote.regularMarketChangePercent as number) ?? 0,
          volume:
            interval === "15m"
              ? fetchedCandles[fetchedCandles.length - 1].volume
              : ((quote.regularMarketVolume as number) ?? fetchedCandles[fetchedCandles.length - 1].volume),
          name: (quote.longName ?? quote.shortName ?? symbol) as string,
        });
      })
    );
    if (i + CONCURRENCY < symbols.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return results;
}

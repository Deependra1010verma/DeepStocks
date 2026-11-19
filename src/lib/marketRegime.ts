import { fetchHistoricalCandles, fetchQuote } from "@/lib/dataFetcher";
import { calcEMA } from "@/lib/indicators";
import { dateToISTString, getMarketSession, latestCompletedSession } from './timezone';
import { assessDataQuality } from './dataQuality';
import { getIndexSession, mergeExchangeClose } from './nseSessionData';

export type RegimeLabel = "BULLISH" | "NEUTRAL" | "BEARISH";

export interface MarketRegimeSnapshot {
  available: boolean;
  regime: RegimeLabel;
  niftyClose: number | null;
  niftyEma20: number | null;
  niftyEma50: number | null;
  indiaVix: number | null;
  defensiveMode: boolean;
  riskMultiplier: number;
  positionRiskPercent: number;
  reason: string;
  generatedAt: string;
}

let cached: { expiresAt: number; sessionKey: string; value: MarketRegimeSnapshot } | null = null;

function last(values: number[]): number | null {
  return values.length ? values[values.length - 1] : null;
}

export async function getMarketRegime(): Promise<MarketRegimeSnapshot> {
  const now = new Date(), session = getMarketSession(now);
  const completedDay = latestCompletedSession(now);
  const sessionKey = `${dateToISTString(now)}:${session.state}:${completedDay}`;
  if (cached && cached.sessionKey === sessionKey && cached.expiresAt > +now) return cached.value;
  const live = session.state === 'LIVE';
  const [niftyHistory, niftyQuote, vixQuote, closedReport] = await Promise.all([
    fetchHistoricalCandles("^NSEI", "1d", new Date(+now - 180 * 86400000)),
    live ? fetchQuote('^NSEI') : null,
    live ? fetchQuote("^INDIAVIX") : null,
    !live && session.calendarVerified && session.state !== 'UNKNOWN' ? getIndexSession(completedDay) : null
  ]);
  const niftyCompleted = niftyHistory.filter(bar=>completedDay&&dateToISTString(new Date(bar.date))<=completedDay);
  const validSession = (bar:typeof niftyHistory[number]|undefined)=>!!bar&&!!completedDay&&dateToISTString(new Date(bar.date))===completedDay;
  const official = live && !validSession(niftyCompleted.at(-1)) ? await getIndexSession(completedDay) : closedReport;
  const officialNifty=official?.get('^NSEI');
  const mergedNifty = completedDay && officialNifty ? mergeExchangeClose(niftyCompleted, officialNifty, completedDay) : null;
  const niftyCandles = mergedNifty ?? niftyCompleted;
  const niftyCloses=niftyCandles.map(bar=>bar.close);
  const niftyEma20=last(calcEMA(niftyCloses,20));
  const niftyEma50=last(calcEMA(niftyCloses,50));
  const quoteFresh=(quote:typeof vixQuote)=>!!quote&&!assessDataQuality(
    quote.regularMarketTime??null,quote.regularMarketTime??null,
    typeof quote.exchangeDataDelayedBy==='number'?quote.exchangeDataDelayedBy:null,false,now
  ).stale;
  const niftyClose=live?(niftyQuote?.regularMarketPrice??null):officialNifty?.candle.close ?? null;
  const vixClose=live?(vixQuote?.regularMarketPrice??null):
    (official?.get('^INDIAVIX')?.candle.close??null);
  const indexFresh=validSession(niftyCandles.at(-1))&&(live?quoteFresh(niftyQuote):!!mergedNifty);
  const vixFresh=live?quoteFresh(vixQuote):!!official?.get('^INDIAVIX');
  const bullish = niftyClose != null && niftyEma20 != null && niftyEma50 != null &&
    niftyClose > niftyEma20 && niftyEma20 > niftyEma50 && vixClose != null && vixClose < 16;
  const available = session.calendarVerified&&indexFresh&&vixFresh&&
    [niftyClose,niftyEma20,niftyEma50,vixClose].every(value=>value!=null&&Number.isFinite(value)&&value>0);
  const defensiveMode = !available || (niftyClose != null && niftyEma20 != null && niftyClose < niftyEma20) ||
    (vixClose != null && vixClose > 18);
  const regime: RegimeLabel = !available ? "NEUTRAL" : bullish ? "BULLISH" : defensiveMode ? "BEARISH" : "NEUTRAL";

  const value: MarketRegimeSnapshot = {
    available,
    regime,
    niftyClose,
    niftyEma20,
    niftyEma50,
    indiaVix: vixClose,
    defensiveMode,
    riskMultiplier: !available ? 0 : bullish ? 1 : 0.5,
    positionRiskPercent: !available ? 0 : bullish ? 1 : 0.5,
    reason: !available ? 'Nifty/VIX inputs unavailable or stale — new risk blocked.' : defensiveMode
      ? `Defensive mode: ${niftyClose != null && niftyEma20 != null && niftyClose < niftyEma20 ? "Nifty is below EMA20" : "India VIX is elevated"}.`
      : bullish
      ? "Full-risk mode: Nifty trend is bullish and India VIX is below 16."
      : "Neutral mode: wait for stronger index and volatility confirmation.",
    generatedAt: new Date().toISOString(),
  };
  cached = { value, sessionKey, expiresAt: Date.now() + 60_000 };
  return value;
}

import { fetchCorporateEventRisk, type StockData } from "@/lib/dataFetcher";
import { type MarketRegimeSnapshot } from "@/lib/marketRegime";
import { type ScreenerMode, type ScreenedStock } from "@/lib/screenerEngine";
import { dateToISTString, tradingDaysAway, latestCompletedSession, getMarketSession, todayIST } from "@/lib/timezone";
import { entryEvidence, qualifiesForShortlist, requiresOvernightClearance } from './strategyPolicy';
import { evaluateFundamentalQuality } from './fundamentalQuality';
import { getTradePlan } from './tradePlan';
import { calcATR, calcEMA, type OHLCV } from './indicators';
import { beforeDeadline } from './deadline';
import type { Instrument } from './marketReference';
import type { NseEventReports } from './nseCorporateEvents';
import type { NseSurveillanceReports } from './nseSurveillance';
import type { NsePriceBand } from './nsePriceBands';
import { referenceEntryReasons } from './entryClearance';
import { recheckDataQuality } from './dataQuality';

const MIN_TURNOVER = 25_00_00_000; // ₹25 crore
const STRICT_RVOL_MODES: ScreenerMode[] = ["intraday", "btst", "swing_breakout"];

export function marketEntryReasons(mode: ScreenerMode, rvol: number, market: MarketRegimeSnapshot): string[] {
  const reasons: string[] = [];
  if (market.available === false && mode !== 'longterm') reasons.push('Nifty/VIX data unavailable');
  if (market.defensiveMode && STRICT_RVOL_MODES.includes(mode) && rvol < 1.8) {
    reasons.push('Defensive regime requires RVOL ≥1.8 for momentum entries');
  }
  return reasons;
}

function estimatedBasisPoints(value: string|undefined, fallback:number):number {
  const number=value?.trim()?Number(value):NaN;
  return Number.isFinite(number)&&number>=0&&number<=1000?number:fallback;
}

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function aggregateDaily(candles: StockData["candles"]): DailyBar[] {
  const grouped = new Map<string, DailyBar>();
  for (const candle of candles) {
    const key = dateToISTString(new Date(candle.date));
    const old = grouped.get(key);
    if (!old) {
      grouped.set(key, { date: key, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume });
      continue;
    }
    old.high = Math.max(old.high, candle.high);
    old.low = Math.min(old.low, candle.low);
    old.close = candle.close;
    old.volume += candle.volume;
  }
  return [...grouped.values()].sort((a,b) => a.date.localeCompare(b.date));
}

export function turnover(_stock: ScreenedStock, data: StockData): number | null {
  const lastComplete = latestCompletedSession();
  const daily = aggregateDaily(data.candles).filter(bar => lastComplete && bar.date <= lastComplete).slice(-20);
  if (daily.length < 20) return null;
  const values = daily.map(bar => bar.close * bar.volume);
  return values.every(Number.isFinite) ? values.reduce((a,b) => a+b,0)/20 : null;
}
export function circuitLockedInLastFive(data: StockData): boolean {
  const daily = aggregateDaily(data.candles).slice(-6);
  return daily.slice(1).some((bar,i) => {
    const prior = daily[i].close;
    return prior > 0 && bar.high === bar.low && Math.abs(bar.close / prior - 1) >= 0.04;
  });
}
function monthlyTrend(data?: StockData): ScreenedStock['monthlyTrend'] {
  const months = new Map<string, number>();
  const currentMonth = dateToISTString(new Date()).slice(0,7);
  for (const c of data?.monthlyCandles ?? []) {
    const month = dateToISTString(new Date(c.date)).slice(0,7);
    if (month < currentMonth) months.set(month, c.close);
  }
  const closes = [...months.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v);
  if (closes.length < 24) return 'UNAVAILABLE';
  const ema = calcEMA(closes,20).at(-1)!;
  return closes.at(-1)! > ema ? 'BULLISH' : 'BEARISH';
}

function nearTrendSupport(cmp: number, bars: OHLCV[] | undefined, period: number): boolean {
  if (!bars || bars.length < Math.max(14, period)) return false;
  const average = calcEMA(bars.map(bar => bar.close), period).at(-1);
  const atr = calcATR(bars).at(-1);
  return average != null && atr != null && atr > 0 && cmp >= average && cmp - average <= atr;
}

export async function applyInstitutionalGuards(
  mode: ScreenerMode,
  candidates: ScreenedStock[],
  stockDataMap: Map<string, StockData>,
  market: MarketRegimeSnapshot,
  deadline = Date.now() + 15000,
  instruments?:ReadonlyMap<string,Instrument>,
  exchange?: {
    events?: NseEventReports;
    surveillance?: NseSurveillanceReports;
    priceBands?: ReadonlyMap<string,NsePriceBand>;
  },
): Promise<ScreenedStock[]> {
  const guarded: ScreenedStock[] = [];
  const overnight = requiresOvernightClearance(mode);
  const referenceCoverage = {
    earnings: exchange?.events?.earnings, actions: exchange?.events?.actions,
    asm: exchange?.surveillance?.asm, gsm: exchange?.surveillance?.gsm
  };
  // Bound calendar fan-out. Candidate ordering does not imply qualification.
  for (let offset = 0; offset < candidates.length; offset += 6) {
    const chunk = await Promise.all(candidates.slice(offset, offset + 6).map(async (candidate) => {
      const instrument=instruments?.get(candidate.symbol);
      const validInstrument = instrument?.symbol === candidate.symbol &&
        /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(instrument.isin) &&
        Number.isFinite(instrument.tickSize) && instrument.tickSize > 0;
      const exchangePriceBand = exchange?.priceBands?.get(candidate.symbol);
      const stock={
        ...candidate,
        tickSize: validInstrument ? instrument.tickSize : undefined,
        tickSizeAsOf: validInstrument ? todayIST() : undefined,
        casEligible: instrument?.casEligible,
        referenceCoverage, exchangePriceBand,
        estimatedCostBps:estimatedBasisPoints(process.env.PAPER_COST_BPS,20),
        estimatedSlippageBps:estimatedBasisPoints(process.env.PAPER_SLIPPAGE_BPS,5),
      };
      const data = stockDataMap.get(stock.symbol);
      const fundamentals = stock.fundamentals;
      const unknownEvents = { earningsDate: null, corporateEventDate: null, corporateEventType: null, eventStatus: 'unknown' as const };
      const events = fundamentals.eventStatus === 'known' ? fundamentals : Date.now() > deadline - 2500 ? unknownEvents : await beforeDeadline(() => fetchCorporateEventRisk(stock.symbol), Math.min(deadline, Date.now() + 2200)).catch(() => unknownEvents);
      const now = new Date(), today = dateToISTString(now);
      if (stock.dataQuality) stock.dataQuality = recheckDataQuality(stock.dataQuality, mode === 'intraday', now);
      const official = exchange?.events?.entries.get(stock.symbol)?.filter(item => item.day >= today) ?? [];
      const surveillance = exchange?.surveillance?.entries.get(stock.symbol) ?? [];
      const officialResults = official.filter(item => item.kind === 'earnings');
      const yahooDay = events.earningsDate ? dateToISTString(new Date(events.earningsDate)) : null;
      const providerDates = [events.earningsDate, events.corporateEventDate].filter((value): value is string => !!value)
        .map(value => new Date(value)).filter(date => !(dateToISTString(date) < today));
      const distances = [...providerDates, ...official.map(item => new Date(item.day+'T12:00:00+05:30'))]
        .map(date => tradingDaysAway(now, date));
      const earningsDaysAway = distances.filter((days): days is number => days != null && days <= 5)
        .sort((a,b) => a-b)[0] ?? null;
      const eventConflict = officialResults.length > 0 && !!yahooDay && yahooDay >= today &&
        officialResults.some(item => item.day !== yahooDay);
      const eventStatus: ScreenedStock['eventStatus'] = !distances.includes(null) && (officialResults.length > 0 ||
        (events.eventStatus === 'known' && yahooDay && yahooDay !== 'Invalid Date' && yahooDay >= today)) ? 'known' : 'unknown';
      const earningsRisk = overnight && (earningsDaysAway !== null || eventConflict);
      const liquidityTurnover = data ? turnover(stock, data) : null;
      const circuitLockedRecent = data ? circuitLockedInLastFive(data) : false;
      const liquidityPass = liquidityTurnover != null && liquidityTurnover >= MIN_TURNOVER && !circuitLockedRecent;
      const reasons = [...(stock.guardReasons ?? [])];
      if (overnight && earningsDaysAway !== null) reasons.push('Earnings/event within five exchange sessions — do not hold overnight');
      if (overnight && eventConflict) reasons.push('Yahoo and NSE results dates disagree. Verify the exchange filing.');
      if (surveillance.length) reasons.push(...surveillance.map(entry =>
        instrument?.isin && instrument.isin!==entry.isin
          ? `NSE ${entry.measure} symbol match requires ISIN verification`
          : `NSE surveillance flag ${entry.code} · ${entry.asOf}`
      ));
      if (overnight && eventStatus === 'unknown') reasons.push('Upcoming earnings calendar or session distance unverified — overnight clearance unavailable');
      const referenceReasons = referenceEntryReasons(stock, now);
      reasons.push(...referenceReasons);
      if (mode !== 'longterm' && !instruments?.size) reasons.push('Current NSE instrument master unavailable');
      else if (instruments?.size && !instrument) reasons.push('Symbol is missing in today’s NSE EQ instrument master; verify listing or rename');
      if (!liquidityPass) reasons.push(circuitLockedRecent ? 'Possible circuit-locked bar in last five sessions; exchange price-band verification required' : liquidityTurnover == null ? '20 completed sessions required for turnover verification' : 'Average estimated turnover below ₹25 crore');
      reasons.push(...marketEntryReasons(mode, stock.rvol, market));
      if (!stock.dataQuality || stock.dataQuality.stale) {
        const issues = stock.dataQuality?.issues;
        reasons.push(...(issues?.length ? issues : ['Data freshness unverified']));
      }
      if ((mode==='intraday'||mode==='btst') && stock.dataQuality?.delayMinutes!==0) {
        reasons.push(`Delayed/unknown feed — ${mode==='btst'?'BTST':'intraday'} execution signal disabled`);
      }
      const plan=getTradePlan(stock);
      if(mode!=='longterm'){
        if(!plan)reasons.push('Invalid numeric trade plan');
        reasons.push(...(plan?.reasons??[]));
      }
      if(instrument&&(!instrument.buyAllowed||!instrument.sellAllowed))reasons.push('Instrument master reports a buy/sell restriction');
      const actionCandles = mode === 'intraday' ? data?.candles : data?.candles.slice(-20);
      if (actionCandles?.some(c => c.splitReported) || official.some(event => event.day === today && event.changesPriceBasis)) {
        reasons.push('Reported corporate action requires verification of price and volume adjustment');
      }
      if (['intraday','btst'].includes(mode) && getMarketSession(new Date(),stock.casEligible ?? null).state !== 'LIVE') reasons.push('Continuous trading session is not confirmed open');
      const monthly = monthlyTrend(data);
      if (mode === 'longterm') {
        if (monthly !== 'BULLISH') reasons.push('Completed monthly trend is not confirmed bullish');
        if (!nearTrendSupport(stock.cmp, data?.weeklyCandles, 20) && !nearTrendSupport(stock.cmp, data?.monthlyCandles, 10)) {
          reasons.push('Price is outside the weekly EMA20 and monthly EMA10 support zones');
        }
        reasons.push(...evaluateFundamentalQuality(fundamentals.annualHistory, stock.sector));
        if (fundamentals.forwardPE == null || !Number.isFinite(fundamentals.forwardPE) || fundamentals.forwardPE <= 0 || fundamentals.forwardPE > 40) reasons.push('Valuation needs review: forward PE unavailable or above research threshold');
      }
      if (mode === 'positional' && ![fundamentals.returnOnEquity,fundamentals.revenueGrowth,fundamentals.forwardPE].every(Number.isFinite)) reasons.push('Required positional fundamentals unavailable');
      const researchQualified=mode==='longterm'&&!stock.nearMiss&&reasons.length===0;
      reasons.push(...entryEvidence(stock));
      const verificationNote = 'Published price bands are reference data. Verify effective limits and circuit status with the exchange or broker before execution.';
      return { ...stock, researchQualified, eventStatus, exchangeEvents: official, eventConflict, surveillance, exchangePriceBand,
        earningsDate: events.earningsDate, corporateEventDate: events.corporateEventDate, corporateEventType: events.corporateEventType, earningsRisk, earningsDaysAway, liquidityTurnover, liquidityPass, circuitLockedRecent, liquidityWarning: liquidityPass ? undefined : reasons.find(r=>/turnover|circuit|sessions required/.test(r)), monthlyTrend: monthly, defensiveMode: market.defensiveMode, riskMultiplier: market.riskMultiplier, positionRiskPercent: stock.nearMiss || reasons.length ? 0 : market.positionRiskPercent, regime: market.regime, regimeReason: market.reason, nearMiss: Boolean(stock.nearMiss || reasons.length), guardReasons: [...new Set(reasons)], verificationNote };
    }));
    guarded.push(...chunk);
  }
  return rankSectorCandidates(guarded);
}

export function rankSectorCandidates(stocks: ScreenedStock[]): ScreenedStock[] {
  const counts = new Map<string, number>();
  for (const stock of stocks.filter(qualifiesForShortlist)) {
    counts.set(stock.sector, (counts.get(stock.sector) ?? 0) + 1);
  }
  const ranks = new Map<string, number>();
  return [...stocks].sort((a, b) => b.quantScore - a.quantScore).map(stock => {
    const qualified = qualifiesForShortlist(stock);
    const rank = (ranks.get(stock.sector) ?? 0) + 1;
    if (qualified) ranks.set(stock.sector, rank);
    return { ...stock, sectorCluster: (counts.get(stock.sector) ?? 0) >= 3, primaryRank: qualified && rank <= 2 };
  }).sort((a, b) =>
    Number(qualifiesForShortlist(b)) - Number(qualifiesForShortlist(a)) ||
    Number(b.primaryRank) - Number(a.primaryRank) ||
    b.quantScore - a.quantScore
  );
}

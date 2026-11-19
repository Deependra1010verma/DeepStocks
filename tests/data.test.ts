import { it,expect,vi,afterEach } from 'vitest';
const yahoo=vi.hoisted(()=>({chart:vi.fn(),quote:vi.fn(),quoteSummary:vi.fn(),fundamentalsTimeSeries:vi.fn()}));
vi.mock('yahoo-finance2',()=>({default:class{chart=yahoo.chart;quote=yahoo.quote;quoteSummary=yahoo.quoteSummary;fundamentalsTimeSeries=yahoo.fundamentalsTimeSeries;}}));
vi.mock('../src/lib/db',()=>({connectDB:vi.fn().mockRejectedValue(new Error('isolated: no DB'))}));
vi.mock('../src/lib/nseSessionData',()=>({getCashSession:async()=>new Map(),getIndexSession:async()=>new Map(),restoreCashSpecialSessions:async(_:string,bars:unknown[])=>bars}));
import { parseCalendarEvents,fetchHistoricalCandles,fetchFundamentals,type StockData } from '../src/lib/dataFetcher';
import { turnover,circuitLockedInLastFive,applyInstitutionalGuards } from '../src/lib/riskGuards';
import { getMarketRegime,type MarketRegimeSnapshot } from '../src/lib/marketRegime';
import { stock,bar,NOW } from './fixtures';
import { enforceRiskGuards } from '../src/lib/analysisRules';
import { referenceEntryReasons } from '../src/lib/entryClearance';
import type { ScreenedStock } from '../src/lib/screenerEngine';
import { recordPaperSignal, updatePaperLedger } from '../src/lib/ledgerService';
import { SignalLedger } from '../src/lib/models/SignalLedger';
afterEach(()=>vi.useRealTimers());
afterEach(()=>vi.unstubAllGlobals());

function exchangeReferences(...symbols: string[]) {
  const fresh = {status:'verified-empty' as const, checkedAt:NOW.toISOString()};
  const instruments = new Map(symbols.map(symbol => [symbol, {symbol,name:symbol,isin:'INE0D0U01013',tickSize:.05,casEligible:true,buyAllowed:true,sellAllowed:true}]));
  const exchange = {
    events: {entries:new Map(), earnings:fresh, actions:fresh},
    surveillance: {entries:new Map(), asm:fresh, gsm:fresh},
    priceBands: new Map(symbols.map(symbol => [symbol,{percent:null,publishedDay:'2026-11-17'}]))
  };
  return {instruments,exchange};
}

it('preserves annual fiscal dates and ratio units while rejecting duplicate provider rows', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  yahoo.quoteSummary.mockResolvedValue({financialData:{returnOnEquity:.18,revenueGrowth:.12,debtToEquity:35}});
  yahoo.quote.mockResolvedValue({marketCap:1000});
  const annual = [2024,2025,2026].map(year => ({
    date:new Date(`${year}-03-31T00:00:00Z`),periodType:'12M',totalRevenue:120,netIncome:10,
    operatingCashFlow:20,totalDebt:5,stockholdersEquity:100,ordinarySharesNumber:100
  }));
  yahoo.fundamentalsTimeSeries.mockResolvedValueOnce(annual).mockResolvedValueOnce([...annual,annual[2]]);
  const clean = await fetchFundamentals('FY.NS');
  expect(clean).toMatchObject({qualityHistoryStatus:'verified',asOf:NOW.toISOString(),
    returnOnEquity:.18,revenueGrowth:.12,debtToEquity:35});
  expect(clean.annualHistory?.map(row=>row.date)).toEqual(['2024-03-31','2025-03-31','2026-03-31']);
  expect((await fetchFundamentals('FY.NS')).qualityHistoryStatus).toBe('unavailable');
});

it('uses one dated NSE action check and writes an unresolved ledger result without pricing a bonus', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const start = new Date('2026-11-17T09:15:00+05:30');
  const signal = {symbol:'ALPHA.NS',signalDate:'2026-11-17',status:'OPEN',createdAt:start,filledAt:start,
    updatedAt:start,entryExpiresAt:NOW,expiresAt:new Date(+NOW+24*3600000),entry:100,stopLoss:90};
  const request = vi.fn(async () => Response.json([
    {symbol:'ALPHA',series:'EQ',subject:'Bonus 1:1',exDate:'18-Nov-2026'},
    {symbol:'BETA',series:'EQ',subject:'Dividend',exDate:'18-Nov-2026'}
  ]));
  vi.stubGlobal('fetch',request);
  const read = vi.spyOn(SignalLedger,'find').mockReturnValue({sort:()=>({limit:()=>({lean:async()=>[signal]})})} as never);
  const write = vi.spyOn(SignalLedger,'updateOne').mockResolvedValue({} as never);
  const chartCalls = yahoo.chart.mock.calls.length;
  try {
    expect(await updatePaperLedger()).toEqual({checked:1,pending:0});
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toEqual([expect.stringContaining('from_date=17-11-2026&to_date=18-11-2026'),expect.anything()]);
    expect(yahoo.chart).toHaveBeenCalledTimes(chartCalls);
    expect(write.mock.calls[0]?.[1]).toMatchObject({$set:{status:'UNRESOLVED',outcomeReason:expect.stringMatching(/Corporate action/)}});
    expect((write.mock.calls[0]?.[1] as {$set:{realizedR?:number}}).$set.realizedR).toBeUndefined();
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

function positional(earningsDate: string) {
  const candidate = stock({
    mode: 'positional', target1: 1150, target2: 1200, entryConfirmationAt: '2026-11-17T09:15:00+05:30',
    fundamentals: {...stock().fundamentals, eventStatus: 'known', earningsDate,
      returnOnEquity: .2, revenueGrowth: .2, forwardPE: 20}
  });
  const data = {...candidate, candles: candidate.candles.map(c => ({...c,volume:1e7}))} as unknown as StockData;
  const market = {available:true,regime:'BULLISH',defensiveMode:false,positionRiskPercent:1,riskMultiplier:1} as MarketRegimeSnapshot;
  return { candidate, data: new Map([[candidate.symbol,data]]), market };
}

it('blocks a Positional setup ahead of confirmed earnings', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const {candidate,data,market} = positional('2026-11-19T10:00:00Z');
  const {instruments,exchange} = exchangeReferences(candidate.symbol);
  const [result] = await applyInstitutionalGuards('positional',[candidate],data,market,undefined,instruments,exchange);
  expect(result).toMatchObject({earningsRisk:true, earningsDaysAway:1, nearMiss:true, positionRiskPercent:0});
  expect(enforceRiskGuards({},result)).toMatchObject({verdictBadge:'WATCHLIST ONLY',convictionScore:4});
});

it('retains a research card but blocks entry when exchange references are missing', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const {candidate,data,market} = positional('2026-12-15T10:00:00Z');
  const [result] = await applyInstitutionalGuards('positional',[candidate],data,market);
  expect(result).toMatchObject({symbol:candidate.symbol, nearMiss:true, positionRiskPercent:0});
  expect(result.guardReasons?.join(' ')).toMatch(/instrument master unavailable/);
});

it('distinguishes verified-empty, unavailable and flagged references for the same Positional setup', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const {candidate,data,market} = positional('2026-12-15T10:00:00Z');
  const {instruments,exchange} = exchangeReferences(candidate.symbol);
  const run = async () => (await applyInstitutionalGuards('positional',[candidate],data,market,undefined,instruments,exchange))[0];
  expect(await run()).toMatchObject({nearMiss:false,positionRiskPercent:1});
  exchange.surveillance.gsm = {...exchange.surveillance.gsm,checkedAt:new Date(+NOW-15*60_000).toISOString()};
  expect((await run()).guardReasons).toContain('NSE GSM report needs a fresh check');
  exchange.surveillance.gsm = exchange.surveillance.asm;
  exchange.surveillance.entries.set(candidate.symbol,[{measure:'ASM',asOf:'2026-11-18',isin:'INE0D0U01013',code:'LTASM - I (13)'}]);
  expect((await run()).guardReasons).toContain('NSE surveillance flag LTASM - I (13) · 2026-11-18');
  const [missingSymbol] = await applyInstitutionalGuards('positional',[candidate],data,market,undefined,exchangeReferences('OTHER.NS').instruments,exchange);
  expect(missingSymbol.guardReasons?.join(' ')).toMatch(/missing in today’s NSE EQ instrument master/);
});

it('retains unknown overnight distance across the unverified calendar year', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const {candidate,data,market} = positional('2027-01-05T10:00:00Z');
  const {instruments,exchange} = exchangeReferences(candidate.symbol);
  const [result] = await applyInstitutionalGuards('positional',[candidate],data,market,undefined,instruments,exchange);
  expect(result).toMatchObject({eventStatus:'unknown',positionRiskPercent:0});
  expect(result.guardReasons?.join(' ')).toMatch(/session distance unverified/);
});

it('blocks paper registration independently of qualification flags when coverage is missing or expires', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const {candidate,data,market} = positional('2026-12-15T10:00:00Z');
  const {instruments,exchange} = exchangeReferences(candidate.symbol);
  const [allowed] = await applyInstitutionalGuards('positional',[candidate],data,market,undefined,instruments,exchange);
  const write = vi.spyOn(SignalLedger, 'findOneAndUpdate').mockReturnValue({lean:async()=>({status:'PENDING'})} as never);
  try {
    await expect(recordPaperSignal({...allowed,nearMiss:true,positionRiskPercent:0})).rejects.toMatchObject({code:'NOT_QUALIFIED'});
    await expect(recordPaperSignal({...allowed,referenceCoverage:undefined})).rejects.toMatchObject({code:'NOT_QUALIFIED'});
    expect(write).not.toHaveBeenCalled();
    await expect(recordPaperSignal(allowed)).resolves.toMatchObject({status:'PENDING'});
    vi.setSystemTime(new Date(+NOW+15*60_000));
    expect(referenceEntryReasons(allowed)).toContain('NSE GSM report needs a fresh check');
    await expect(recordPaperSignal(allowed)).rejects.toMatchObject({code:'NOT_QUALIFIED'});
    expect(write).toHaveBeenCalledTimes(1);
  } finally { write.mockRestore(); }
});

it('parses empty reports as verified and marks malformed or stale HTTP reports unavailable', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/reportASM')) return Response.json({longterm:{data:[]},shortterm:{data:[]}});
    if (url.endsWith('/reportGSM')) return Response.json([], {headers:{age:'901'}});
    if (url.includes('corporateActions')) return Response.json([{symbol:'ALPHA',series:'EQ',subject:'Split'}]);
    return Response.json([]);
  });
  vi.stubGlobal('fetch',fetch);
  const {getNseEventReports} = await import('../src/lib/nseCorporateEvents');
  const {getNseSurveillanceReports} = await import('../src/lib/nseSurveillance');
  const [events,surveillance] = await Promise.all([getNseEventReports(),getNseSurveillanceReports()]);
  expect(events).toMatchObject({earnings:{status:'verified-empty'},actions:{status:'unavailable'}});
  expect(surveillance).toMatchObject({asm:{status:'verified-empty'},gsm:{status:'unavailable'}});
  expect(fetch).toHaveBeenCalledTimes(5);
});
it('parses actual nested Yahoo earningsDate schema',()=>{vi.useFakeTimers();vi.setSystemTime(NOW);const event=parseCalendarEvents({calendarEvents:{earnings:{earningsDate:[new Date('2026-11-20T00:00:00Z')]}}});expect(event.earningsDate).toBe('2026-11-20T00:00:00.000Z');expect(event.eventStatus).toBe('known');});
it('missing event data stays unknown',()=>expect(parseCalendarEvents({}).eventStatus).toBe('unknown'));
it('a short candle request cannot poison a longer history request',async()=>{yahoo.chart.mockImplementation(async(_symbol,query)=>({quotes:Array.from({length:query.period1.getUTCMonth()===10?7:250},(_,i)=>bar(new Date(Date.UTC(2026,0,i+1)).toISOString()))}));const short=await fetchHistoricalCandles('RANGE.NS','1d',new Date('2026-11-01'));const long=await fetchHistoricalCandles('RANGE.NS','1d',new Date('2026-01-01'));expect(short).toHaveLength(7);expect(long).toHaveLength(250);});
it('identical concurrent candle requests share one provider call',async()=>{yahoo.chart.mockClear();yahoo.chart.mockResolvedValue({quotes:[bar('2026-11-18')]});const from=new Date('2026-11-01');await Promise.all([fetchHistoricalCandles('DEDUPE.NS','1d',from),fetchHistoricalCandles('DEDUPE.NS','1d',from)]);expect(yahoo.chart).toHaveBeenCalledTimes(1);});
it('three daily bars cannot pass a twenty-session liquidity gate',()=>{const s=stock();expect(turnover(s,{...s,candles:s.candles.slice(0,3)} as unknown as StockData)).toBeNull();});
it('flat circuit-like gap is detected against previous close',()=>expect(circuitLockedInLastFive({candles:[bar('2026-11-17',100),bar('2026-11-18',105)]} as StockData)).toBe(true));
it('unknown Nifty/VIX blocks new position risk',async()=>{yahoo.quote.mockResolvedValue(null);yahoo.chart.mockResolvedValue({quotes:[]});const regime=await getMarketRegime();expect(regime.available).toBe(false);expect(regime.positionRiskPercent).toBe(0);});
it('three stocks in one sector remain visible but only two get primary rank',async()=>{
  vi.useFakeTimers();vi.setSystemTime(NOW);
  const stocks=[1,2,3].map(i=>stock({symbol:`SECTOR${i}.NS`,breakoutDaysAgo:1,target1:1110,target2:1160,fundamentals:{...stock().fundamentals,eventStatus:'known',earningsDate:'2026-12-20T00:00:00Z'}}));
  const data=new Map(stocks.map(s=>[s.symbol,{...s,candles:s.candles.map(c=>({...c,volume:1e7}))} as unknown as StockData]));
  const regime={available:true,regime:'NEUTRAL',defensiveMode:false,positionRiskPercent:1,riskMultiplier:1,reason:'fixture'} as MarketRegimeSnapshot;
  const {instruments,exchange} = exchangeReferences(...stocks.map((s:ScreenedStock) => s.symbol));
  const result=await applyInstitutionalGuards('swing_breakout',stocks,data,regime,undefined,instruments,exchange);
  expect(result.filter(s=>!s.nearMiss)).toHaveLength(3);
  expect(result.filter(s=>s.primaryRank)).toHaveLength(2);
  expect(result.every(s=>s.sectorCluster)).toBe(true);
});

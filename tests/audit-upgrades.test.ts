import { afterEach, expect, it, vi } from 'vitest';
import { NOW, bar, stock } from './fixtures';
import { enforceRiskGuards } from '../src/lib/analysisRules';
import { buildResearchEvidence, validateEvidenceSelection } from '../src/lib/researchEvidence';
import { getTradePlan } from '../src/lib/tradePlan';
import { getMarketSession, latestCompletedSession } from '../src/lib/timezone';
import { chooseScheduledMode } from '../src/lib/scanSchedule';
import {
  applyPortfolioAction,
  DEFAULT_RISK_POLICY,
  emptyPortfolio,
  holdingQuantityDifferences,
  portfolioSizing,
  positionReview
} from '../src/lib/portfolioEngine';
import { parseInstrumentMaster } from '../src/lib/marketReference';
import { parseGrowwQuote } from '../src/lib/growwReadOnly';
import { replayHoldout } from '../src/lib/paperReplay';
import { breakoutRetest } from '../src/lib/screenerEngine';
import { sectorBenchmarks } from '../src/lib/sectorBenchmarks';
import { attachResultsFilings, parseNseEvents } from '../src/lib/nseCorporateEvents';
import { exchangePositionReview } from '../src/lib/portfolioExchangeReview';
import { parseSurveillanceReports } from '../src/lib/nseSurveillance';
import { parseNsePriceBands } from '../src/lib/nsePriceBands';
import type { Position } from '../src/lib/portfolioEngine';
afterEach(() => vi.useRealTimers());

it('uses dated sector-index performance against Nifty and leaves absent benchmarks unscored', () => {
  const start = new Map([['^NSEI',{ candle:bar('2026-10-19', 100) }],['Nifty IT',{ candle:bar('2026-10-19', 100) }]]);
  const end = new Map([['^NSEI',{ candle:bar('2026-11-18', 102) }],['Nifty IT',{ candle:bar('2026-11-18', 104) }]]);
  const result = sectorBenchmarks(start,end,'2026-10-19','2026-11-18');
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ index:'Nifty IT', sector:'IT', scoreBoost:10 });
  expect(result[0].relativeChange).toBeCloseTo(2);
  expect(sectorBenchmarks(start,new Map(),'2026-10-19','2026-11-18')).toEqual([]);
});

it('validates exchange dates, distinguishes results from other meetings, and ignores invalid actionable events', () => {
  const payload = [
    {symbol:'ALPHA',date:'20-Nov-2026',purpose:'Financial Results'},
    {symbol:'ALPHA',date:'19-Nov-2026',purpose:'Fund Raising'},
    {symbol:'ALPHA',date:'31-Nov-2026',purpose:'Financial Results'}
  ];
  expect(parseNseEvents(payload,'earnings',NOW).get('ALPHA.NS')).toMatchObject([{day:'2026-11-20',kind:'earnings'}]);
  const result = parseNseEvents([{symbol:'ALPHA',exDate:'19-Nov-2026',series:'EQ',subject:'Bonus 1:1'}],'action',NOW);
  expect(result.get('ALPHA.NS')).toMatchObject([{day:'2026-11-19',label:'Bonus'}]);
});

it('links a matching official filing only after its exchange publication time', () => {
  const events = parseNseEvents([{symbol:'ALPHA',date:'20-Nov-2026',purpose:'Financial Results'}],'earnings',NOW);
  const url='https://nsearchives.nseindia.in/corporate/ALPHA_results.xml';
  attachResultsFilings(events,[
    {bm_symbol:'ALPHA',bm_date:'20-Nov-2026',bm_timestamp:'18-Nov-2026 11:00:00',bm_desc:'Consider financial results',attachment:url},
    {bm_symbol:'ALPHA',bm_date:'20-Nov-2026',bm_timestamp:'18-Nov-2026 10:00:00',bm_desc:'Consider financial results',attachment:url}
  ],NOW);
  expect(events.get('ALPHA.NS')?.[0]).toMatchObject({source:url,publishedAt:'2026-11-18T04:30:00.000Z'});
});

it('preserves verified dates on both exchange surveillance lists without treating absence as clearance', () => {
  const asm = {longterm:{data:[{symbol:'ALPHA',isin:'INE0D0U01013',asmTime:'18-Nov-2026',survCode:'LTASM - I (13)'}]}};
  const gsm = [{symbol:'BETA',isin:'INE976R01033',gsmTime:'17-Nov-2026 08:07:02',survCode:'GSM 0 (1)'}];
  const result = parseSurveillanceReports(asm,gsm,NOW);
  expect(result.get('ALPHA.NS')?.[0]).toMatchObject({measure:'ASM',asOf:'2026-11-18'});
  expect(result.get('BETA.NS')?.[0]).toMatchObject({measure:'GSM',asOf:'2026-11-17'});
  expect(result.has('GAMMA.NS')).toBe(false);
});

it('uses EQ price bands and distinguishes no fixed band from missing or conflicting data', () => {
  const csv='Symbol,Series,Security Name,Band,Remarks\nALPHA,EQ,Alpha,5,-\nBETA,EQ,Beta,No Band,-\nBETA,BE,Beta,2,-\nGAMMA,EQ,Gamma,20,-\nGAMMA,EQ,Gamma,5,-';
  const entries=parseNsePriceBands(csv,'2026-11-18');
  expect(entries.get('ALPHA.NS')).toEqual({percent:5,publishedDay:'2026-11-18'});
  expect(entries.get('BETA.NS')).toEqual({percent:null,publishedDay:'2026-11-18'});
  expect(entries.has('GAMMA.NS')).toBe(false);
});

it('reviews exchange closes only after the recorded fill and keeps an official event visible', () => {
  const position:Position = {
    id:'position-id',symbol:'ALPHA.NS',sector:'IT',mode:'swing_breakout',quantity:5,averagePrice:120,
    initialStop:110,stop:110,target1:140,target2:150,openedAt:'2026-11-16T10:00:00+05:30',
    lastFillAt:'2026-11-16T10:00:00+05:30',mark:null,markAt:null,stopHistory:[]
  };
  const official = {candle:bar('2026-11-17',108)};
  const upcoming = parseNseEvents([{symbol:'ALPHA',exDate:'19-Nov-2026',series:'EQ',subject:'Bonus 1:1'}],'action',NOW);
  const result = exchangePositionReview(position,'2026-11-17',official,upcoming.get('ALPHA.NS')!,NOW);
  expect(result.alerts[0]).toMatch(/at or below the recorded stop/);
  expect(result.upcoming).toHaveLength(1);
  expect(exchangePositionReview({...position,lastFillAt:NOW.toISOString()},'2026-11-17',official,[],NOW).alerts)
    .toEqual(['The exchange close predates the last recorded fill.']);
});

it('compares share counts for both broker-only and journal-only holdings',()=>{
  const differences=holdingQuantityDifferences(
    [{symbol:'ALPHA.NS',quantity:2},{symbol:'ALPHA.NS',quantity:3},{symbol:'BETA.NS',quantity:1}],
    [{symbol:'ALPHA.NS',quantity:5},{symbol:'GAMMA.NS',quantity:4}]
  );
  expect(differences).toEqual([{symbol:'BETA.NS',broker:1,journal:0},{symbol:'GAMMA.NS',broker:0,journal:4}]);
});

it('old free-text claims cannot survive as evidence or a verdict', () => {
  const s = stock({
    mode: 'intraday',
    fundamentals: { ...stock().fundamentals, revenueGrowth: 0.12, debtToEquity: 50 }
  });
  const report = enforceRiskGuards(
    {
      executiveSummary: 'Guaranteed buy',
      technicalBreakdown: ['20-day EMA', 'High relative volatility'],
      fundamentalCheck: ['In line with sector average']
    },
    s
  );
  expect(JSON.stringify(report)).not.toMatch(
    /Guaranteed buy|20-day EMA|High relative volatility|In line with sector average/
  );
  expect(report.evidence?.find((e) => e.id === 'ema')?.text).toContain('15-minute bars');
  expect(report.evidence?.find((e) => e.id === 'debt')?.text).toContain('50.00% (ratio 0.50×)');
  expect(report.verdictBadge).toBe('WATCHLIST ONLY');
  const facts = buildResearchEvidence(s);
  expect(() =>
    validateEvidenceSelection(
      { technical: ['ema'], fundamental: ['invented-peer'], news: [], risk: [] },
      facts
    )
  ).toThrow();
  expect(() =>
    validateEvidenceSelection({ technical: [' '], fundamental: [], news: [], risk: [] }, facts)
  ).toThrow();
  expect(
    validateEvidenceSelection(
      { technical: ['ema', 'rvol'], fundamental: ['debt'], news: ['no-news'], risk: ['qualification'] },
      facts
    ).technical
  ).toEqual(['ema', 'rvol']);
});

it('applies the cost gate and rounds to a dated tick conservatively', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  expect(getTradePlan(stock())?.accepted).toBe(false);
  const plan = getTradePlan(
    stock({
      atr: 20.03,
      defaultSL: 970.02,
      target1: 1100.03,
      target2: 1150.07,
      tickSize: 0.05,
      tickSizeAsOf: '2026-11-18'
    })
  )!;
  expect(plan.stopLoss).toBe(970);
  expect(plan.entryHigh).toBe(1010);
  expect(plan.target1).toBe(1100);
  expect(plan.netRiskReward).toBeLessThan(plan.riskRewardRatio);
  expect(plan.accepted).toBe(true);
  expect(getTradePlan(stock({ tickSize: 0.05, tickSizeAsOf: '2026-11-17' }))?.tickSize).toBeNull();
});

it('requires a completed retest near the breakout level and rejects failure below it', () => {
  const candles = Array.from({ length: 20 }, (_, i) =>
    bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString())
  );
  candles.push({ ...bar('2026-11-16', 110, 200), low: 100 }, { ...bar('2026-11-17', 103), low: 100 });
  expect(breakoutRetest(candles, 10, NOW)?.level).toBe(100);
  candles.at(-1)!.close = 98;
  expect(breakoutRetest(candles, 10, NOW)).toBeNull();
});

it('distinguishes CAS by instrument and effective date', () => {
  const at = new Date('2026-11-18T15:20:00+05:30');
  expect(getMarketSession(at, true).label).toBe('CLOSING AUCTION');
  expect(getMarketSession(at, false).state).toBe('LIVE');
  expect(getMarketSession(new Date('2026-12-07T15:20:00+05:30'), true).state).toBe('LIVE');
  expect(getMarketSession(new Date('2026-12-07T15:31:00+05:30'), true).label).toBe('CLOSING AUCTION');
  expect(latestCompletedSession(new Date('2026-12-07T15:43:00+05:30'), true)).toBe('2026-12-04');
  expect(getMarketSession(new Date('2026-01-15T11:00:00+05:30')).state).toBe('CLOSED');
});

it('continues the persisted due batch and chooses quality modes during EOD', () => {
  const row = {
    mode: 'intraday' as const,
    version: 'v',
    expiresAt: new Date(+NOW - 1),
    updatedAt: NOW,
    progress: {
      startedAt: new Date(+NOW - 60000).toISOString(),
      processed: ['A'],
      failed: [],
      deferred: ['B']
    }
  };
  expect(chooseScheduledMode([row], 'v', NOW)).toBe('intraday');
  expect(chooseScheduledMode([{ ...row, expiresAt: new Date(+NOW + 60000) }], 'v', NOW)).toBe(
    'swing_breakout'
  );
  expect(chooseScheduledMode([], 'v', new Date('2026-11-18T15:51:00+05:30'))).toBe('positional');
  expect(chooseScheduledMode([], 'v', new Date('2026-11-24T10:30:00+05:30'))).toBeNull();
  expect(chooseScheduledMode([], 'v', new Date('2026-11-18T14:46:00+05:30'))).toBe('btst');
  expect(chooseScheduledMode([], 'v', new Date('2026-12-07T15:20:00+05:30'))).toBe('btst');
});

it('date-specific master resolves ticks and does not use expired F&O contracts', () => {
  const header =
    'exchange,segment,series,trading_symbol,isin,tick_size,underlying_symbol,expiry_date,buy_allowed,sell_allowed,name';
  const result = parseInstrumentMaster(
    header +
      '\nNSE,CASH,EQ,ALPHA,INE123,0.05,,,1,0,"Alpha, Ltd"\nNSE,FNO,,ALPHA26,,0.05,ALPHA,2026-11-17,1,1,Future',
    '2026-11-18'
  );
  expect(result).toEqual([
    {
      symbol: 'ALPHA.NS',
      name: 'Alpha, Ltd',
      isin: 'INE123',
      tickSize: 0.05,
      casEligible: false,
      buyAllowed: true,
      sellAllowed: false
    }
  ]);
});

it('retains exchange time and price bands without calling an old Groww trade live', () => {
  const quote = parseGrowwQuote(
    {
      last_price: 100,
      last_trade_time: +NOW - 180000,
      upper_circuit_limit: 110,
      lower_circuit_limit: 90
    },
    NOW
  );
  expect(quote).toMatchObject({ stale: true, upper: 110, lower: 90, bid: null, ask: null });
  expect(() => parseGrowwQuote({ last_price: 100, last_trade_time: +NOW + 61000 }, NOW)).toThrow();
});

it('records actual fills once, reduces risk at a justified stop and realizes net P/L', () => {
  let p = applyPortfolioAction(
    emptyPortfolio(),
    { id: 'settings-1', type: 'settings', cash: 100000, policy: DEFAULT_RISK_POLICY },
    NOW
  );
  p = applyPortfolioAction(p, { id: 'reconcile-1', type: 'reconcile' }, NOW);
  const buy = {
    id: 'buy-fill-1',
    type: 'fill',
    side: 'BUY',
    symbol: 'ALPHA.NS',
    sector: 'IT',
    mode: 'swing_breakout',
    quantity: 10,
    price: 100,
    fees: 10,
    at: NOW.toISOString(),
    stop: 90,
    target1: 110,
    target2: 120
  } as const;
  p = applyPortfolioAction(p, buy, NOW);
  expect(applyPortfolioAction(p, buy, NOW)).toBe(p);
  expect(p.cash).toBe(98990);
  expect(p.positions[0].averagePrice).toBe(101);
  expect(() =>
    applyPortfolioAction(
      p,
      { id: 'stop-bad-1', type: 'stop', positionId: buy.id, stop: 80, reason: 'wider stop' },
      NOW
    )
  ).toThrow();
  p = applyPortfolioAction(
    p,
    {
      id: 'stop-good-1',
      type: 'stop',
      positionId: buy.id,
      stop: 95,
      reason: 'Observed support moved up'
    },
    NOW
  );
  expect(p.positions[0].initialStop).toBe(90);
  p = applyPortfolioAction(
    p,
    {
      ...buy,
      id: 'sell-fill-1',
      side: 'SELL',
      quantity: 4,
      price: 112,
      fees: 4,
      stop: undefined,
      target1: undefined,
      target2: undefined
    },
    NOW
  );
  expect(p.positions[0].quantity).toBe(6);
  expect(p.events.at(-1)?.realized).toBe(40);
  expect(positionReview(p.positions[0], NOW).join(' ')).toContain('Partial exit recorded');
});

it('portfolio sizing accounts for reserved exposure and stale position inputs', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const p = {
    ...emptyPortfolio(),
    configured: true,
    cash: 100000,
    reconciledAt: NOW.toISOString(),
    reservations: [
      {
        id: 'reserved',
        symbol: 'OTHER.NS',
        sector: 'IT',
        quantity: 20,
        cash: 24400,
        risk: 100,
        createdAt: NOW.toISOString()
      }
    ]
  };
  const plan = getTradePlan(
    stock({ target1: 1100, target2: 1150, tickSize: 0.05, tickSizeAsOf: '2026-11-18' })
  );
  expect(portfolioSizing(p, plan, 'IT', 'ALPHA.NS', 1, NOW).quantity).toBe(0);
  expect(portfolioSizing(p, plan, 'Banking', 'ALPHA.NS', 1, NOW).quantity).toBeGreaterThan(0);
  expect(portfolioSizing(p, plan, 'Banking', 'ALPHA.NS', 1, new Date(+NOW + 86400000)).quantity).toBe(0);
});

it('rejects a holdout record whose inputs arrived after the decision', () => {
  const at = NOW.toISOString();
  const signal = {
    status: 'PENDING' as const,
    entry: 100,
    entryLow: 99,
    entryHigh: 101,
    stopLoss: 90,
    target1: 120,
    target2: 130,
    costBps: 20,
    slippageBps: 5,
    createdAt: at,
    entryExpiresAt: '2026-11-19T09:30:00+05:30',
    expiresAt: '2026-11-20T15:15:00+05:30'
  };
  const row = {
    id: 'row',
    symbol: 'ALPHA.NS',
    strategyVersion: 'frozen-v1',
    decisionAt: at,
    inputsAvailableAt: at,
    signal,
    bars: []
  };
  const input = {
    source: 'fixture',
    strategyVersion: 'frozen-v1',
    tuneThrough: '2026-11-16',
    holdoutThrough: '2026-11-30',
    cases: [row]
  };
  expect(replayHoldout(input).stats.winRate).toBeNull();
  expect(() =>
    replayHoldout({ ...input, cases: [{ ...row, inputsAvailableAt: '2026-11-19' }] })
  ).toThrow(/look-ahead/);
});

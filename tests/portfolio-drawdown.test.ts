import { expect, it, vi } from 'vitest';
import { applyPortfolioAction, DEFAULT_RISK_POLICY, emptyPortfolio, portfolioSizing, portfolioTotals } from '../src/lib/portfolioEngine';
import { loadPortfolioPriorCloses } from '../src/lib/portfolioService';
import type { NumericTradePlan } from '../src/lib/tradePlan';
import { NOW, stock } from './fixtures';
import { NextRequest } from 'next/server';
import { POST } from '../src/app/api/portfolio/route';

const sources = vi.hoisted(() => ({closes:vi.fn(),actions:vi.fn(),read:vi.fn(),save:vi.fn(),resolve:vi.fn()}));
vi.mock('../src/lib/nseSessionData', () => ({getCashSession:sources.closes}));
vi.mock('../src/lib/nseCorporateEvents', () => ({getNsePriceBasisActions:sources.actions}));
vi.mock('../src/lib/portfolioService', async original => ({
  ...await original<object>(),readPortfolio:sources.read,savePortfolioAction:sources.save
}));
vi.mock('../src/lib/stockService', async original => ({...await original<object>(),resolveStock:sources.resolve}));
vi.mock('../src/lib/apiSecurity', async original => ({
  ...await original<object>(),authorizeRequest:async()=>undefined
}));

const plan: NumericTradePlan = {
  accepted:true, reasons:[], entryLow:99, entryHigh:100, entry:100, stopLoss:95,
  target1:115, target2:120, riskRewardRatio:3, netRiskReward:2.8, minimumNetRR:1.5,
  estimatedCostBps:20, estimatedSlippageBps:5, tickSize:.05, chaseLimit:100,
  validUntil:'2026-11-19T15:15:00+05:30',policyVersion:'fixture',trigger:'',invalidation:'',holdingPeriod:''
};
const settings = (cash: number) => ({
  id:'settings-1', type:'settings' as const, cash, policy:DEFAULT_RISK_POLICY
});
const buy = {
  id:'fill-buy-1',type:'fill' as const,side:'BUY' as const,symbol:'OLD.NS',sector:'Banking',
  mode:'swing_breakout' as const,quantity:200,price:100,fees:0,stop:74,at:NOW.toISOString()
};
const yesterday = new Date('2026-11-17T14:00:00+05:30');
const previous = {session:'2026-11-17',prices:{'OLD.NS':80}};
function carriedPortfolio() {
  const p = applyPortfolioAction(emptyPortfolio(), settings(100000), yesterday);
  return applyPortfolioAction(p,{...buy,at:yesterday.toISOString()},yesterday);
}

function lossPortfolio() {
  let p = applyPortfolioAction(emptyPortfolio(), settings(100000), NOW);
  p = applyPortfolioAction(p, buy, NOW);
  p = applyPortfolioAction(p, {id:'mark-loss-1',type:'mark',positionId:buy.id,price:75,at:NOW.toISOString()}, NOW);
  return applyPortfolioAction(p, {id:'review-today',type:'reconcile'}, NOW);
}

it('blocks a fresh entry after the audited ₹5,000 same-day marked loss', () => {
  const sizing = portfolioSizing(lossPortfolio(),plan,'IT','NEW.NS',1,NOW);
  expect(sizing.totals).toMatchObject({equity:95000,realizedToday:0,unrealized:-5000});
  expect(sizing.totals.dailyEquity).toMatchObject({openingEquity:100000,netCashFlow:0,pnl:-5000,percent:-5});
  expect(sizing.quantity).toBe(0);
  expect(sizing.reasons).toContain('Daily equity loss limit reached');
});

it('rejects a journal reservation at the API before any save after the daily loss limit', async () => {
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(NOW);
  try {
    const p = lossPortfolio();
    const verified = {status:'verified-empty' as const,checkedAt:NOW.toISOString()};
    sources.read.mockResolvedValue(p);
    sources.resolve.mockResolvedValue(stock({
      symbol:'NEW.NS',breakoutDaysAgo:1,target1:1100,target2:1150,tickSize:.05,tickSizeAsOf:'2026-11-18',
      referenceCoverage:{earnings:verified,actions:verified,asm:verified,gsm:verified},
      exchangePriceBand:{publishedDay:'2026-11-17',percent:10}
    }));
    const response = await POST(new NextRequest('https://deepstocks.test/api/portfolio',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({version:p.version,action:{id:'reserve-test',type:'reserve',symbol:'NEW',mode:'swing_breakout',quantity:1}})
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({code:'RISK_LIMIT',error:'Daily equity loss limit reached'});
    expect(sources.save).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it('reconciles a partial sale, fees and cash flows from the prior close while retaining exposure caps', () => {
  let p = carriedPortfolio();
  p = applyPortfolioAction(p,{...buy,id:'fill-sell-1',side:'SELL',quantity:50,price:90,fees:10,stop:undefined},NOW);
  p = applyPortfolioAction(p,{id:'mark-today',type:'mark',positionId:buy.id,price:85,at:NOW.toISOString()},NOW);
  p = applyPortfolioAction(p,{...settings(94490),id:'deposit-today'},NOW);
  p = applyPortfolioAction(p,{...settings(91490),id:'withdraw-today'},NOW);
  p = applyPortfolioAction(p,{id:'review-today',type:'reconcile'},NOW);
  p = applyPortfolioAction(p,{id:'reserve-today',type:'reserve',reservation:{
    id:'reservation',symbol:'OTHER.NS',sector:'IT',quantity:20,cash:24400,risk:100,createdAt:NOW.toISOString()
  }},NOW);

  const sizing = portfolioSizing(p,plan,'IT','NEW.NS',1,NOW,previous);
  expect(sizing.totals).toMatchObject({equity:104240,availableCash:67090,openRisk:1695,reservedRisk:100,realizedToday:-510});
  expect(sizing.totals.dailyEquity).toMatchObject({openingEquity:96000,netCashFlow:7000,pnl:1240});
  // Equity × 25% − ₹24,400 reserved = ₹1,660. ₹100.25 per share leaves 16 shares.
  expect(sizing.quantity).toBe(16);
});

it('requires a correctly dated prior close even after every carried share has been sold', () => {
  const p = applyPortfolioAction(carriedPortfolio(),{...buy,id:'fill-sell-2',side:'SELL',price:78,fees:20,stop:undefined},NOW);
  expect(p.positions).toHaveLength(0);
  expect(portfolioTotals(p,NOW).dailyEquity.reason).toMatch(/previous NSE session closes/i);
  expect(portfolioTotals(p,NOW,{...previous,session:'2026-11-16'}).dailyEquity.pnl).toBeNull();
  expect(portfolioTotals(p,NOW,previous).dailyEquity).toMatchObject({openingEquity:96000,pnl:-420});
});

it('keeps the original loss boundary after a deposit and fails closed for a zero limit', () => {
  let p = applyPortfolioAction(emptyPortfolio(),settings(100000),NOW);
  p = applyPortfolioAction(p,{...buy,stop:89},NOW);
  p = applyPortfolioAction(p,{id:'mark-limit',type:'mark',positionId:buy.id,price:90,at:NOW.toISOString()},NOW);
  p = applyPortfolioAction(p,{...settings(180000),id:'deposit-large'},NOW);
  p = applyPortfolioAction(p,{id:'review-today',type:'reconcile'},NOW);
  // Old journal notes provide deterministic cash deltas for pre-upgrade events.
  delete p.events.find(event => event.id === 'deposit-large')!.cashFlow;
  const sizing = portfolioSizing(p,plan,'IT','NEW.NS',1,NOW);
  expect(sizing.totals.dailyEquity).toMatchObject({openingEquity:100000,netCashFlow:100000,pnl:-2000,percent:-2});
  expect(sizing.reasons).toContain('Daily equity loss limit reached');
  const policy = {...p.policy,dailyLossPercent:0};
  expect(() => applyPortfolioAction(p,{...settings(p.cash),policy,id:'settings-zero'},NOW)).toThrow(/supported bounds/);
  expect(portfolioSizing({...p,policy},plan,'IT','NEW.NS',1,NOW).reasons).toContain('Set a valid positive daily equity loss limit');
});

it('accepts a mark exactly 20 minutes old and withholds equity from older, future or invalid marks', () => {
  const p = carriedPortfolio();
  p.positions[0].mark = 82;
  p.positions[0].markAt = new Date(+NOW-20*60_000).toISOString();
  expect(portfolioTotals(p,NOW,previous).dailyEquity.pnl).toBe(400);
  expect(portfolioTotals(p,new Date(+NOW+1),previous).dailyEquity.pnl).toBeNull();
  for (const markAt of [new Date(+NOW+1).toISOString(),'invalid',null]) {
    p.positions[0].markAt = markAt;
    expect(portfolioTotals(p,NOW,previous).dailyEquity.reason).toMatch(/current holding marks/i);
  }
});

it('loads only carried symbols and blocks an incompatible opening price basis', async () => {
  sources.closes.mockResolvedValue(new Map([['OLD.NS',{candle:{close:80}}],['OTHER.NS',{candle:{close:110}}]]));
  sources.actions.mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map([['OLD.NS',['2026-11-18']]]));
  const p = carriedPortfolio();
  expect(await loadPortfolioPriorCloses(p,NOW)).toEqual(previous);
  expect(sources.closes).toHaveBeenCalledWith('2026-11-17');
  expect(sources.actions).toHaveBeenCalledWith('2026-11-18','2026-11-18');
  expect(await loadPortfolioPriorCloses(p,NOW)).toMatchObject({issue:expect.stringMatching(/corporate-action reconciliation/)});
  expect(await loadPortfolioPriorCloses(emptyPortfolio(),NOW)).toBeNull();
  expect(sources.closes).toHaveBeenCalledTimes(2);
});

import { describe,it,expect,vi,afterEach } from 'vitest';
import { getMarketSession,nextMarketOpen,tradingDaysAway } from '../src/lib/timezone';
import { sessionVWAP,finalizeResults } from '../src/lib/screenerEngine';
import { computeRVOL } from '../src/lib/relativeVolume';
import { getTradePlan,positionSize,formatTradeSetup } from '../src/lib/tradePlan';
import { assessDataQuality } from '../src/lib/dataQuality';
import { getAIExpiry,priceMovedBeyondCache,guardFingerprint } from '../src/lib/aiCachePolicy';
import { enforceRiskGuards } from '../src/lib/analysisRules';
import { evaluateFundamentalQuality } from '../src/lib/fundamentalQuality';
import { bar,stock,NOW } from './fixtures';
afterEach(()=>vi.useRealTimers());
describe('NSE session and freshness',()=>{
  it.each([['2026-11-18T10:35:00+05:30','LIVE'],['2026-11-18T09:10:00+05:30','PRE_OPEN'],['2026-11-18T15:29:59+05:30','UNKNOWN'],['2026-11-18T15:35:00+05:30','CLOSED'],['2026-11-15T10:35:00+05:30','CLOSED'],['2026-01-26T10:35:00+05:30','CLOSED'],['2026-11-08T18:00:00+05:30','UNKNOWN'],['2027-01-04T10:35:00+05:30','UNKNOWN']])('%s → %s',(date,state)=>expect(getMarketSession(new Date(date)).state).toBe(state));
  it('skips the holiday when computing the next opening',()=>expect(nextMarketOpen(new Date('2026-11-23T16:00:00+05:30')).toISOString()).toBe('2026-11-25T03:45:00.000Z'));
  it('earnings blackout counts exchange sessions, not weekends/holidays',()=>expect(tradingDaysAway(new Date('2026-11-20T12:00:00+05:30'),new Date('2026-11-25T12:00:00+05:30'))).toBe(2));
  it('a 15-minute delayed quote is identified without pretending to be real-time',()=>{const d=assessDataQuality('2026-11-18T10:20:00+05:30','2026-11-18T09:15:00+05:30',15,false,NOW);expect(d.stale).toBe(false);expect(d.delayMinutes).toBe(15);expect(d.incompleteCandle).toBe(true);});
  it.each([['2026-11-17T15:30:00+05:30','2026-11-18T09:15:00+05:30',15],['2026-11-18T10:20:00+05:30','2026-11-16T09:15:00+05:30',15],['2026-11-18T10:20:00+05:30','2026-11-18T09:15:00+05:30',null],['2026-11-18T11:20:00+05:30','2026-11-18T09:15:00+05:30',15]] as const)('blocks stale/unknown quote %s candle %s delay %s',(q,c,d)=>expect(assessDataQuality(q,c,d,false,NOW).stale).toBe(true));
  it('allows a fresh quote with the last completed daily session only for daily modes',()=>{
    const quote='2026-11-18T10:20:00+05:30', candle='2026-11-17T09:15:00+05:30';
    expect(assessDataQuality(quote,candle,15,false,NOW).stale).toBe(false);
    expect(assessDataQuality(quote,candle,15,true,NOW).stale).toBe(true);
  });
});
describe('volume and current-session indicators',()=>{
  it('intraday RVOL sums only contiguous completed slots and uses ten comparable sessions',()=>{
    const cut = '2026-11-18T09:49:00+05:30';
    const bars=['02','03','04','05','06','09','11','12','13','16','17','18'].flatMap(day=>
      ['09:15','09:30','09:45'].map((time,i)=>bar(`2026-11-${day}T${time}:00+05:30`,100,i===2?100000:day==='18'?200:day==='02'?10000:100))
    );
    expect(computeRVOL(bars, 1000000, true, cut, NOW)).toMatchObject({
      kind:'intraday-cumulative', volume:400, averageVolume:200, value:2,
      through:'2026-11-18T04:15:00.000Z'
    });
    expect(computeRVOL(bars.slice(6), 0, true, cut, NOW)).toBeNull();
    expect(computeRVOL(bars.filter(b=>b.date.toISOString()!=='2026-11-18T03:45:00.000Z'), 0, true, cut, NOW)).toBeNull();
    expect(computeRVOL(bars, 0, true, '2026-11-18T09:29:00+05:30', NOW)).toBeNull();
  });
  it('VWAP resets for each session',()=>expect(sessionVWAP([bar('2026-11-17T15:00:00+05:30',200),bar('2026-11-18T09:15:00+05:30',100)])).toBe(100));
  it('keeps all fifteen qualifiers',()=>expect(finalizeResults(Array.from({length:15},(_,i)=>stock({symbol:`S${i}.NS`})),[],[])).toHaveLength(15));
});
describe('authoritative plan and cache',()=>{
  it('cash quantity, displayed levels and copied plan agree',()=>{const p=getTradePlan(stock({defaultSL:999,atr:0.5}))!;const s=positionSize(p,900000,1);expect(s.quantity).toBe(897);expect(s.capitalRequired).toBeLessThanOrEqual(900000);expect(formatTradeSetup('ALPHA.NS',p,s.quantity)).toContain('Qty: 897');expect(p.stopLoss).toBe(999);});
  it.each([{defaultSL:1001},{target1:990},{atr:0},{cmp:NaN}])('rejects invalid plan %j',x=>expect(getTradePlan(stock(x))).toBeNull());
  it('guards override a fabricated strong buy and AI stop',()=>{const s=stock({nearMiss:true,rvol:0.6});const a=enforceRiskGuards({convictionScore:10,verdictBadge:'STRONG BUY SETUP',tradePlan:{entryZone:'1',stopLoss:'1',stopLossReason:'',target1:'2',target2:'3',holdingPeriod:'',riskRewardRatio:''}},s);expect(a.convictionScore).toBeLessThanOrEqual(6);expect(a.verdictBadge).toBe('WATCHLIST ONLY');expect(a.tradePlan.stopLoss).toBe('₹970.00');});
  it('earnings invalidates report identity and caps confidence',()=>{const s=stock(),changed=stock({earningsRisk:true});expect(guardFingerprint(s)).not.toBe(guardFingerprint(changed));expect(enforceRiskGuards({},changed).convictionScore).toBeLessThanOrEqual(4);});
  it('movement is measured from original analyzed CMP',()=>{expect(priceMovedBeyondCache('swing_breakout',100,101)).toBe(false);expect(priceMovedBeyondCache('swing_breakout',100,101.6)).toBe(true);});
  it('closed-market cache expires at the next verified opening',()=>expect(getAIExpiry('swing_breakout',new Date('2026-11-20T17:00:00+05:30')).toISOString()).toBe('2026-11-23T03:45:00.000Z'));
  it('intraday cache expires at the next candle bucket',()=>expect(getAIExpiry('intraday',NOW).toISOString()).toBe('2026-11-18T05:15:00.000Z'));
  it('long-term research requires multi-year statements',()=>expect(evaluateFundamentalQuality(undefined,'IT',NOW).length).toBeGreaterThan(0));
});

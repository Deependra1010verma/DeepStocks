import { it,expect } from 'vitest';
import { evaluatePaperSignal,summarizePaperSignals,signalExpiry,PAPER_EVALUATION_VERSION,type PaperSignal } from '../src/lib/ledgerEngine';
import { bar } from './fixtures';
const base: PaperSignal={status:'PENDING',entryLow:99,entryHigh:101,entry:100,stopLoss:90,target1:110,target2:120,createdAt:'2026-11-18T04:15:00Z',entryExpiresAt:'2026-11-20T04:00:00Z',expiresAt:'2026-12-01T04:00:00Z',slippageBps:0,costBps:0};
const now=new Date('2026-11-18T10:00:00Z');
const candle=(o:number,h:number,l:number,c:number,date='2026-11-18T04:15:00Z')=>({...bar(date,c),open:o,high:h,low:l});
it('does not use a candle that started before signal creation',()=>expect(evaluatePaperSignal({...base,createdAt:'2026-11-18T04:16:00Z'},[candle(100,120,90,110)],now).status).toBe('PENDING'));
it('does not fill a price zone never touched',()=>expect(evaluatePaperSignal(base,[candle(105,108,103,106)],now).status).toBe('PENDING'));
it('same candle SL/target is excluded, never a manufactured win',()=>{const s=evaluatePaperSignal(base,[candle(100,115,89,110)],now);expect(s.status).toBe('AMBIGUOUS');expect(s.realizedR).toBeUndefined();});
it('intrabar entry/target sequence is unresolved',()=>expect(evaluatePaperSignal(base,[candle(105,115,99,110)],now).status).toBe('AMBIGUOUS'));
it('continues from T1 to T2 on later bars',()=>{const first=evaluatePaperSignal(base,[candle(100,112,99,111)],now);expect(first.status).toBe('TARGET1');const end=evaluatePaperSignal(first,[candle(111,122,105,121,'2026-11-18T04:30:00Z')],now);expect(end.status).toBe('TARGET2');expect(end.realizedR).toBe(1.5);});
it('after T1, retouching T1 with stop does not create false ambiguity',()=>{const first=evaluatePaperSignal(base,[candle(100,112,99,111)],now);const end=evaluatePaperSignal(first,[candle(105,111,88,89,'2026-11-18T04:30:00Z')],now);expect(end.status).toBe('STOP_LOSS');expect(end.realizedR).toBe(0);});
it('a gap through SL exits at the opening price before later highs',()=>{const s=evaluatePaperSignal({...base,status:'OPEN',filledAt:base.createdAt},[candle(80,112,79,110)],now);expect(s.status).toBe('STOP_LOSS');expect(s.realizedR).toBe(-2);});
it('estimated fees and slippage reduce results',()=>{const s=evaluatePaperSignal({...base,costBps:20,slippageBps:5},[candle(100,121,99,120)],now);expect(s.realizedR).toBeLessThan(1.5);});
it('unfilled expiration is not a losing trade',()=>{const s=evaluatePaperSignal({...base,entryExpiresAt:base.createdAt},[candle(100,105,99,104)],now);expect(s.status).toBe('EXPIRED');expect(summarizePaperSignals([{...s,evaluationVersion:PAPER_EVALUATION_VERSION}]).closed).toBe(0);});
it('legacy, ambiguous and open records are excluded from win rate',()=>{const win={...base,status:'TARGET2' as const,filledAt:base.createdAt,closedAt:base.entryExpiresAt,realizedR:1.5};const stats=summarizePaperSignals([{...win,evaluationVersion:3},{...win,evaluationVersion:PAPER_EVALUATION_VERSION},{...base,status:'AMBIGUOUS',evaluationVersion:PAPER_EVALUATION_VERSION},{...base,evaluationVersion:PAPER_EVALUATION_VERSION}]);expect(stats.closed).toBe(1);expect(stats.legacyExcluded).toBe(1);expect(stats.ambiguous).toBe(1);expect(stats.confidence95?.[0]).toBeLessThan(0.3);});
it('missing price history cannot silently become a win',()=>expect(evaluatePaperSignal(base,[candle(100,120,99,120,'2026-11-25T04:15:00Z')],new Date('2026-11-25T10:00:00Z')).status).toBe('UNRESOLVED'));
it('completed records cannot be reopened by reevaluation',()=>expect(evaluatePaperSignal({...base,status:'STOP_LOSS'},[candle(100,121,99,120)],now).status).toBe('STOP_LOSS'));
it('entry approached from below fills at the touched zone boundary',()=>{const s=evaluatePaperSignal(base,[candle(98,100,97,100)],now);expect(s.status).toBe('OPEN');expect(s.entry).toBe(99);});
it('gap above T2 has known precedence over a later intrabar stop',()=>{const s=evaluatePaperSignal({...base,status:'OPEN',filledAt:base.createdAt},[candle(125,126,85,89)],now);expect(s.status).toBe('TARGET2');expect(s.realizedR).toBe(1.5);});

const openSignal: PaperSignal = {
  ...base, status: 'OPEN', createdAt: '2026-11-18T04:00:00Z', filledAt: '2026-11-18T04:00:00Z',
  entryExpiresAt: '2026-11-18T09:45:00Z', expiresAt: '2026-11-18T09:45:00Z'
};
it('quarantines a refetched window before using prices that may have been adjusted by a later split', () => {
  const early = candle(100,125,95,120,'2026-11-18T04:00:00Z');
  const split = {...candle(50,55,49,52,'2026-11-18T04:15:00Z'),splitReported:true};
  const result = evaluatePaperSignal(openSignal,[early,split],now);
  expect(result).toMatchObject({status:'UNRESOLVED'});
  expect(result.realizedR).toBeUndefined();
});
it('leaves the ledger cursor in place during a corporate-action data outage', () => {
  const target = candle(100,125,95,120,'2026-11-18T04:00:00Z');
  const waiting = evaluatePaperSignal(openSignal,[target],now,undefined,null);
  expect(waiting).toMatchObject({status:'OPEN',outcomeReason:'Waiting for historical NSE corporate-action coverage'});
  expect(waiting.checkedThrough).toBeUndefined();
  expect(evaluatePaperSignal(openSignal,[target],new Date(+now+5*86400000),undefined,null).status).toBe('UNRESOLVED');
  expect(evaluatePaperSignal(waiting,[target],now,undefined,[]).realizedR).toBe(1.5);
});
it('excludes wins across missing candles within a fetch or between fetches', () => {
  const first = candle(100,105,95,101,'2026-11-18T04:00:00Z');
  const last = candle(101,121,100,120,'2026-11-18T04:45:00Z');
  const checkpoint = evaluatePaperSignal(openSignal, [first], now);
  for (const result of [evaluatePaperSignal(openSignal, [first,last], now), evaluatePaperSignal(checkpoint,[last],now)]) {
    expect(result.status).toBe('UNRESOLVED');
    expect(result.realizedR).toBeUndefined();
    expect(result.checkedThrough).toEqual(checkpoint.checkedThrough);
    expect(summarizePaperSignals([{...result,evaluationVersion:PAPER_EVALUATION_VERSION}]).wins).toBe(0);
  }
});
it.each(['2026-11-19T03:45:00Z','2026-11-18T09:45:00Z','2026-11-18T09:30:00Z'])(
  'excludes a target in a bar beyond or straddling expiry (%s)', (at) => {
    const expiry = '2026-11-18T09:40:00Z';
    const result = evaluatePaperSignal({...openSignal, checkedThrough:'2026-11-18T09:30:00Z', expiresAt:expiry},
      [candle(100,125,95,120,at)], new Date('2026-11-19T05:00:00Z'));
    expect(result.status).toBe('UNRESOLVED');
    expect(result.realizedR).toBeUndefined();
  }
);
it('expires a complete path at the final verified close', () => {
  const result = evaluatePaperSignal({...openSignal, checkedThrough:'2026-11-18T09:30:00Z'},
    [candle(100,105,95,104,'2026-11-18T09:30:00Z')], now);
  expect(result).toMatchObject({status:'EXPIRED',exitPrice:104,realizedR:0.4});
  expect(new Date(result.closedAt!).toISOString()).toBe('2026-11-18T09:45:00.000Z');
});
it('allows a known overnight gap through the stop after a complete prior session', () => {
  const result = evaluatePaperSignal({...base,status:'OPEN',filledAt:base.createdAt,checkedThrough:'2026-11-18T10:00:00Z'},
    [candle(80,112,79,110,'2026-11-19T03:45:00Z')], new Date('2026-11-19T05:00:00Z'));
  expect(result).toMatchObject({status:'STOP_LOSS',realizedR:-2});
});
it('uses dated CAS evidence for an overnight gap and never carries it to another date', () => {
  const at = '2026-11-19T03:45:00Z';
  const signal = {...base,status:'OPEN' as const,filledAt:base.createdAt,checkedThrough:'2026-11-18T09:45:00Z'};
  const bars = [candle(80,112,79,110,at)];
  const later = new Date('2026-11-19T05:00:00Z');
  expect(evaluatePaperSignal(signal,bars,later).status).toBe('UNRESOLVED');
  expect(evaluatePaperSignal(signal,bars,later,new Map([['2026-11-18',true]]))).toMatchObject({status:'STOP_LOSS',realizedR:-2});
  const auction = [candle(100,125,95,120,'2026-11-18T09:45:00Z')];
  expect(evaluatePaperSignal(signal,auction,now,new Map([['2026-11-19',false]])).status).toBe('UNRESOLVED');
});
it('quarantines malformed or split-marked price paths', () => {
  for (const invalid of [candle(100,95,91,94,'2026-11-18T04:00:00Z'), {...candle(50,55,49,52,'2026-11-18T04:00:00Z'),splitReported:true}]) {
    expect(evaluatePaperSignal(openSignal,[invalid],now)).toMatchObject({status:'UNRESOLVED'});
  }
});
it('does not count a target with an unverified session or invalid expiry', () => {
  const saturday = '2026-11-21T04:00:00Z';
  const target = candle(100,125,95,120,saturday);
  const signal = {...openSignal,checkedThrough:saturday,expiresAt:'2026-11-23T09:45:00Z'};
  expect(evaluatePaperSignal(signal,[target],new Date('2026-11-21T05:00:00Z')).status).toBe('UNRESOLVED');
  expect(evaluatePaperSignal({...signal,expiresAt:'invalid'},[target],now).status).toBe('UNRESOLVED');
});
it('BTST exits at the next continuous close, skipping weekends and holidays',()=>{
  expect(signalExpiry('btst',new Date('2026-11-20T14:30:00+05:30')).expiresAt.toISOString()).toBe('2026-11-23T09:45:00.000Z');
  expect(signalExpiry('btst',new Date('2026-11-23T14:30:00+05:30')).expiresAt.toISOString()).toBe('2026-11-25T09:45:00.000Z');
  expect(signalExpiry('btst',new Date('2026-12-07T15:20:00+05:30')).entryExpiresAt.toISOString()).toBe('2026-12-07T10:00:00.000Z');
  expect(signalExpiry('intraday',new Date('2026-11-20T10:10:00+05:30'),false).expiresAt.toISOString()).toBe('2026-11-20T10:00:00.000Z');
});

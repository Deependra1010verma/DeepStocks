import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stock, NOW } from './fixtures';
import type { IScanSnapshot } from '../src/lib/models/ScanSnapshot';
import type { StockDataBatch } from '../src/lib/dataFetcher';
const mocks = vi.hoisted(() => ({ snapshot: null as unknown, read: vi.fn(), write: vi.fn(), batch: vi.fn(), operation: vi.fn() }));
vi.mock('../src/lib/db', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/models/ScanSnapshot', () => ({ ScanSnapshot: { findOne: (query: unknown) => ({ maxTimeMS: () => ({ lean: () => mocks.read(query) }) }), updateOne: mocks.write } }));
vi.mock('../src/lib/niftyStocks', () => ({ SECTORS: ['IT'], NSE_SCAN_UNIVERSE: ['A', 'B', 'C'].map(symbol => ({ symbol, sector: 'IT' })) }));
vi.mock('../src/lib/dataFetcher', () => ({ batchFetchStockData: mocks.batch }));
vi.mock('../src/lib/marketRegime', () => ({ getMarketRegime: vi.fn().mockResolvedValue({
  available: true, defensiveMode: false, positionRiskPercent: 1,
}) }));
vi.mock('../src/lib/sectorBenchmarks', () => ({ getSectorBenchmarks: async () => [], usesSectorBenchmark: () => false }));
vi.mock('../src/lib/nseCorporateEvents', () => ({ getNseEventReports: async () => undefined }));
vi.mock('../src/lib/nseSurveillance', () => ({ getNseSurveillanceReports: async () => undefined }));
vi.mock('../src/lib/nsePriceBands', () => ({ getNsePriceBands: async () => new Map() }));
vi.mock('../src/lib/screenerEngine', () => ({ runScreener: (_mode: string, data: Map<string, { invalidated?:boolean; dataQuality: ReturnType<typeof stock>['dataQuality'] }>) => [...data].map(([symbol, item]) => ({ ...stock(), symbol, dataQuality: item.dataQuality, nearMiss: item.invalidated===true, guardReasons: item.invalidated ? ['Trend invalidated'] : [] })) }));
vi.mock('../src/lib/riskGuards', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/riskGuards')>(), applyInstitutionalGuards: vi.fn(async (_mode, candidates) => candidates) }));
vi.mock('../src/lib/operations', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/operations')>();
  return { ...original, withLease: vi.fn(async (_key, work) => work()), recordOperation: mocks.operation };
});
import { getCachedScan, refreshScan, SCAN_VERSION } from '../src/lib/scanService';
import { applyInstitutionalGuards } from '../src/lib/riskGuards';
import { getMarketRegime } from '../src/lib/marketRegime';
import { GET } from '../src/app/api/scan/route';
import { createSession } from '../src/lib/apiSecurity';
import { NextRequest } from 'next/server';

const batch = (symbols: string[], attempted = symbols, stale = false): StockDataBatch => {
  const dataQuality = { ...stock().dataQuality!, stale };
  return Object.assign(new Map(symbols.map(symbol => [symbol, { dataQuality } as never])), {
    coverage: { attempted, failed: attempted.filter(s => !symbols.includes(s)), deferred: [] }
  });
};
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); mocks.snapshot = null;
  mocks.read.mockReset().mockImplementation(async () => mocks.snapshot);
  mocks.write.mockReset().mockImplementation(async (_query, update) => { mocks.snapshot = update.$set; return {}; });
  mocks.operation.mockReset().mockResolvedValue(undefined); mocks.batch.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function snapshotRequest(sector = 'All') {
  vi.stubEnv('APP_ACCESS_PASSWORD', 'test-password-long-enough');
  vi.stubEnv('SESSION_SECRET', 'test-signing-secret-long-enough-for-hmac');
  return new NextRequest(`https://local.test/api/scan?mode=swing_breakout&sector=${sector}`, {
    headers: { cookie: `deepstocks_session=${createSession()}` },
  });
}

it('shares overlapping sector reads and evaluates expiry without changing source timestamps', async () => {
  const report = { status: 'verified-empty' as const, checkedAt: NOW.toISOString() };
  const current = stock({ tickSize: 0.05, tickSizeAsOf: '2026-11-18',
    exchangePriceBand: { publishedDay: '2026-11-18', percent: 10 },
    referenceCoverage: { earnings: report, actions: report, asm: report, gsm: report } });
  const snapshot = { version: SCAN_VERSION, stocks: [current, { ...current, symbol: 'B.NS', sector: 'Banking' }],
    removedToday: [], generatedAt: NOW, expiresAt: new Date(+NOW + 3000) };
  mocks.snapshot = snapshot;
  mocks.read.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return snapshot;
  });
  const all = GET(snapshotRequest());
  const sector = GET(snapshotRequest('IT'));
  await vi.advanceTimersByTimeAsync(20);
  const [allResponse, sectorResponse] = await Promise.all([all, sector]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(allResponse.headers.get('Server-Timing')).toMatch(/connect;dur=.*query;dur=.*render;dur=.*serialize;dur=/);
  expect(sectorResponse.headers.get('Server-Timing')).toContain('shared;dur=');
  expect(sectorResponse.headers.get('Cache-Control')).toBe('no-store');
  expect((await allResponse.json()).stocks).toHaveLength(2);
  const first = await sectorResponse.json();
  expect(first.stocks).toHaveLength(1);
  expect(first.stocks[0]).toMatchObject({ positionRiskPercent: 1, candles: [] });

  await vi.advanceTimersByTimeAsync(3000);
  const expired = await (await GET(snapshotRequest('IT'))).json();
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(expired).toMatchObject({ stale: true, generatedAt: first.generatedAt, expiresAt: first.expiresAt });
  expect(expired.stocks[0]).toMatchObject({ nearMiss: true, positionRiskPercent: 0, dataQuality: { fetchedAt: current.dataQuality!.fetchedAt } });
  expect(expired.stocks[0].guardReasons).toContain('Scan snapshot expired; refresh to revalidate');
  expect(mocks.batch).not.toHaveBeenCalled();
});

it('keeps failed shared reads bounded and attempts storage again on the next request', async () => {
  mocks.read.mockImplementationOnce(() => new Promise(() => {}));
  const first = GET(snapshotRequest());
  const second = GET(snapshotRequest('IT'));
  await vi.advanceTimersByTimeAsync(5000);
  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('15');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' });
  }
  expect(mocks.read).toHaveBeenCalledTimes(1);
  const recovered = await GET(snapshotRequest());
  expect(recovered.status).toBe(200);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  expect(mocks.batch).not.toHaveBeenCalled();
});

it('persists and resumes coverage while retaining earlier successful results', async () => {
  mocks.batch.mockResolvedValueOnce(batch(['A'])).mockResolvedValueOnce(batch(['B'])).mockResolvedValueOnce(batch([], ['C'])).mockResolvedValueOnce(batch(['C']));
  const first = await refreshScan('swing_breakout', 'All');
  expect(first.coverage).toMatchObject({ processed: 1, attempted: 1, deferred: ['B', 'C'] });
  await vi.advanceTimersByTimeAsync(21000);
  const second = await refreshScan('swing_breakout', 'All');
  expect(mocks.batch.mock.calls[1][0]).toEqual(['B', 'C']);
  expect(second.stocks.map(s => s.symbol).sort()).toEqual(['A', 'B']);
  expect(second.coverage).toMatchObject({ processed: 2, attempted: 2 });
  await vi.advanceTimersByTimeAsync(21000);
  const last = await refreshScan('swing_breakout', 'All');
  expect(last.coverage).toMatchObject({ attempted: 3, processed: 2, failed: ['C'], deferred: [] });
  expect(+last.expiresAt - Date.now()).toBe(60000);
  await vi.advanceTimersByTimeAsync(61000);
  const recovered = await refreshScan('swing_breakout', 'All');
  expect(mocks.batch.mock.calls[3][0]).toEqual(['C']);
  expect(recovered.coverage).toMatchObject({ attempted: 3, processed: 3, failed: [], deferred: [] });
  expect(recovered.stocks.map(s => s.symbol).sort()).toEqual(['A','B','C']);
  expect(recovered.stocks.every(s => s.candles.length === 0)).toBe(true);
});
it('a finished scan with only stale market inputs reports unavailable', async () => {
  mocks.batch.mockResolvedValue(batch(['A','B','C'], ['A','B','C'], true));
  const result = await refreshScan('swing_breakout','All');
  expect(result.coverage).toMatchObject({ processed:3, verified:0, deferred:[] });
  expect(result.status).toBe('unavailable');
  mocks.batch.mockResolvedValue(batch(['A','B'], ['A','B','C']));
  await vi.advanceTimersByTimeAsync(61000);
  const recovered=await refreshScan('swing_breakout','All');
  expect(recovered.coverage).toMatchObject({ processed:2, verified:2, failed:['C'], deferred:[] });
  expect(recovered.status).toBe('partial');
  expect(+recovered.expiresAt-Date.now()).toBe(300000);
});
it('records a removal only after a pending qualifier is evaluated with verified data', async () => {
  mocks.snapshot = {
    version: SCAN_VERSION, stocks: [stock({ symbol:'C', nearMiss:false })], removedToday:[],
    generatedAt:new Date(+NOW-3600000), expiresAt:new Date(0)
  };
  const last=batch(['B','C']);
  Object.assign(last.get('C')!, { invalidated:true });
  mocks.batch.mockResolvedValueOnce(batch(['A'])).mockResolvedValueOnce(last);
  const partial=await refreshScan('swing_breakout','All');
  expect(partial.stocks.find(s=>s.symbol==='C')).toMatchObject({nearMiss:true,awaitingRevalidation:true});
  expect(partial.removedToday).toEqual([]);
  await vi.advanceTimersByTimeAsync(21000);
  const finished=await refreshScan('swing_breakout','All');
  expect(finished.removedToday).toMatchObject([{symbol:'C',reason:'Trend invalidated'}]);
  expect(finished.stocks.find(s=>s.symbol==='C')?.awaitingRevalidation).toBe(false);
});
it('keeps previous qualifiers awaiting revalidation during a reference report outage', async () => {
  mocks.snapshot = {
    version: SCAN_VERSION, stocks: [stock({symbol:'A',nearMiss:false})], removedToday:[],
    generatedAt:new Date(+NOW-3600000), expiresAt:new Date(0)
  };
  mocks.batch.mockResolvedValue(batch(['A','B','C']));
  vi.mocked(applyInstitutionalGuards).mockImplementationOnce(async (_mode,candidates) =>
    candidates.map(s => ({...s,referenceCoverage:{},nearMiss:true,positionRiskPercent:0})));
  const result = await refreshScan('swing_breakout','All');
  expect(result.stocks.find(s => s.symbol === 'A')).toMatchObject({nearMiss:true,awaitingRevalidation:true,positionRiskPercent:0});
  expect(result.removedToday).toEqual([]);
});
it('all-provider failure preserves the previous snapshot time and cards as unverified', async () => {
  mocks.snapshot = { version: SCAN_VERSION, stocks: [stock({ symbol: 'A' })], removedToday: [], generatedAt: new Date(+NOW - 3600000), expiresAt: new Date(0) };
  mocks.batch.mockResolvedValue(batch([], ['A', 'B', 'C']));
  const result = await refreshScan('btst', 'All');
  expect(+result.generatedAt).toBe(+NOW - 3600000); expect(result.stocks[0].nearMiss).toBe(true);
  expect(result.status).toBe('unavailable'); expect(result.coverage?.processed).toBe(0);
});
it('recomputes sector concentration across successful batches', async () => {
  vi.mocked(applyInstitutionalGuards).mockImplementation(async (_mode, candidates) =>
    candidates.map(s => ({ ...s, ...freshReferences() })));
  mocks.batch.mockResolvedValueOnce(batch(['A', 'B'])).mockResolvedValueOnce(batch(['C']));
  await refreshScan('swing_breakout', 'All');
  await vi.advanceTimersByTimeAsync(21000);
  const complete = await refreshScan('swing_breakout', 'All');
  expect(complete.stocks.filter(s => s.primaryRank)).toHaveLength(2);
  expect(complete.stocks.every(s => s.sectorCluster)).toBe(true);
});

function freshReferences() {
  const report = { status: 'verified-empty' as const, checkedAt: NOW.toISOString() };
  return { tickSize: 0.05, tickSizeAsOf: '2026-11-18',
    exchangePriceBand: { publishedDay: '2026-11-18', percent: 10 },
    referenceCoverage: { earnings: report, actions: report, asm: report, gsm: report } };
}

it.each([
  { issue: 'quote expiry', reason: 'Data freshness requires revalidation' },
  { issue: 'index outage', reason: 'Nifty/VIX data unavailable' },
  { issue: 'defensive volume limit', reason: 'Defensive regime requires RVOL ≥1.8 for momentum entries' },
  { issue: 'neutral risk cap', reason: undefined },
])('rechecks $issue on retained qualifiers before returning resumed scan results', async ({ issue, reason }) => {
  vi.mocked(applyInstitutionalGuards).mockImplementation(async (_mode, candidates) =>
    candidates.map(s => ({ ...s, ...freshReferences(), rvol: 1.5 })));
  const earlier = batch(['A']);
  if (issue === 'quote expiry') {
    const quality = earlier.get('A')!.dataQuality!;
    quality.delayMinutes = 0;
    quality.quoteAt = new Date(+NOW - 5 * 60000).toISOString();
  }
  mocks.batch.mockResolvedValueOnce(earlier).mockResolvedValueOnce(batch(['B','C']));
  const first = await refreshScan('swing_breakout', 'All');
  expect(first.stocks[0]).toMatchObject({ nearMiss: false, positionRiskPercent: 1 });
  await vi.advanceTimersByTimeAsync(21000);
  if (issue !== 'quote expiry') {
    vi.mocked(getMarketRegime).mockResolvedValueOnce({
      ...await getMarketRegime(), available: issue !== 'index outage',
      defensiveMode: issue !== 'neutral risk cap', positionRiskPercent: issue === 'index outage' ? 0 : 0.5,
    });
  }
  const resumed = await refreshScan('swing_breakout', 'All');
  const carried = resumed.stocks.find(s => s.symbol === 'A');
  expect(carried).toMatchObject({ nearMiss: !!reason, awaitingRevalidation: !!reason, positionRiskPercent: reason ? 0 : 0.5,
    dataQuality: { fetchedAt: first.stocks[0].dataQuality!.fetchedAt } });
  expect(Date.parse(carried?.dataQuality?.quoteAt ?? '')).toBe(Date.parse(first.stocks[0].dataQuality!.quoteAt!));
  if (reason) expect(carried?.guardReasons).toContain(reason);
  expect(resumed.coverage?.verified).toBe(issue === 'quote expiry' ? 2 : 3);
  if (issue === 'quote expiry') expect(resumed.status).toBe('partial');
  expect(resumed.removedToday).toEqual([]);
});
it('legacy snapshots are viewable but cannot clear a new entry', async () => {
  mocks.snapshot = { version: 'old', stocks: [stock()], removedToday: [], generatedAt: NOW, expiresAt: new Date(+NOW + 3600000) };
  const cached = await getCachedScan('swing_breakout', 'All');
  expect(+cached!.expiresAt).toBe(0); expect(cached!.stocks[0].nearMiss).toBe(true);
  expect(cached!.stocks[0].guardReasons).toContain('Calculations need refreshing after engine update');
});
it('recomputes saved Long-Term sector ranks after checking research freshness', async () => {
  const research = [70, 90, 80].map(quantScore => stock({
    symbol: `RESEARCH${quantScore}.NS`, mode: 'longterm', quantScore, nearMiss: true,
    researchQualified: true, primaryRank: false, sectorCluster: false, positionRiskPercent: 0,
  }));
  const stale = { ...research[0], symbol: 'STALE.NS', quantScore: 99,
    dataQuality: { ...research[0].dataQuality!, stale: true } };
  mocks.snapshot = { version: SCAN_VERSION, stocks: [...research, stale], removedToday: [],
    generatedAt: NOW, expiresAt: new Date(+NOW + 3600000) };

  const cached = await getCachedScan('longterm', 'IT');
  expect(cached?.stocks.filter(s => s.researchQualified)).toHaveLength(3);
  expect(cached?.stocks.filter(s => s.primaryRank).map(s => s.symbol)).toEqual(['RESEARCH90.NS', 'RESEARCH80.NS']);
  expect(cached?.stocks.every(s => s.nearMiss && s.positionRiskPercent === 0 && s.sectorCluster)).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(mocks.batch).not.toHaveBeenCalled();
});
it('a provider ignoring cancellation cannot save a late snapshot after the scan deadline', async () => {
  let release!: (value: StockDataBatch) => void;
  mocks.batch.mockImplementation(() => new Promise<StockDataBatch>(resolve => { release = resolve; }));
  const result = refreshScan('positional', 'All');
  const rejected = expect(result).rejects.toMatchObject({ code: 'SCAN_TIMEOUT', status: 504 });
  await vi.advanceTimersByTimeAsync(43000); await rejected;
  release(batch(['A'])); await vi.advanceTimersByTimeAsync(1);
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.batch.mockResolvedValue(batch(['A', 'B', 'C']));
  const recovered = await refreshScan('positional', 'All');
  expect(recovered.coverage?.processed).toBe(3);
  expect((mocks.snapshot as IScanSnapshot).version).toBe(SCAN_VERSION);
});
it('reports an acknowledged-late write as successful after reading the matching snapshot revision', async () => {
  mocks.batch.mockResolvedValue(batch(['A','B','C']));
  mocks.write.mockImplementationOnce(async (_query, update) => {
    mocks.snapshot = update.$set;
    throw new Error('acknowledgment lost');
  });
  const result = await refreshScan('swing_breakout','All');
  const revision = (mocks.snapshot as IScanSnapshot).updatedAt;
  expect(result.coverage?.verified).toBe(3);
  expect(mocks.read).toHaveBeenLastCalledWith({ mode:'swing_breakout', sector:'All', updatedAt:revision, version:SCAN_VERSION });
});
it('rejects an outdated snapshot revision and reports an unconfirmed save by stage', async () => {
  mocks.batch.mockResolvedValue(batch(['A','B','C']));
  mocks.write.mockResolvedValueOnce({ matchedCount:0, upsertedCount:0 });
  await expect(refreshScan('swing_breakout','All')).rejects.toMatchObject({ code:'SNAPSHOT_ADVANCED' });
  mocks.write.mockRejectedValueOnce(new Error('database connection reset'));
  await expect(refreshScan('swing_breakout','All')).rejects.toMatchObject({ code:'SNAPSHOT_WRITE_UNCONFIRMED', retryAfter:15 });
  expect(mocks.operation).toHaveBeenLastCalledWith('scan:swing_breakout',expect.objectContaining({ stage:'snapshot-write', code:'SNAPSHOT_WRITE_UNCONFIRMED' }));
});

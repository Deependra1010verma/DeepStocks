import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stock, NOW } from './fixtures';
import type { IScanSnapshot } from '../src/lib/models/ScanSnapshot';
import type { StockDataBatch } from '../src/lib/dataFetcher';
const mocks = vi.hoisted(() => ({ snapshot: null as unknown, read: vi.fn(), write: vi.fn(), batch: vi.fn(), operation: vi.fn() }));
vi.mock('../src/lib/db', () => ({ connectDB: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/lib/models/ScanSnapshot', () => ({ ScanSnapshot: { findOne: (query: unknown) => ({ maxTimeMS: () => ({ lean: () => mocks.read(query) }) }), updateOne: mocks.write } }));
vi.mock('../src/lib/niftyStocks', () => ({ NSE_SCAN_UNIVERSE: ['A', 'B', 'C'].map(symbol => ({ symbol, sector: 'IT' })) }));
vi.mock('../src/lib/dataFetcher', () => ({ batchFetchStockData: mocks.batch }));
vi.mock('../src/lib/marketRegime', () => ({ getMarketRegime: vi.fn().mockResolvedValue({ available: true }) }));
vi.mock('../src/lib/sectorBenchmarks', () => ({ getSectorBenchmarks: async () => [], usesSectorBenchmark: () => false }));
vi.mock('../src/lib/nseCorporateEvents', () => ({ getNseEvents: async () => new Map() }));
vi.mock('../src/lib/nseSurveillance', () => ({ getNseSurveillance: async () => new Map() }));
vi.mock('../src/lib/nsePriceBands', () => ({ getNsePriceBands: async () => new Map() }));
vi.mock('../src/lib/screenerEngine', () => ({ runScreener: (_mode: string, data: Map<string, { invalidated?:boolean }>) => [...data].map(([symbol, item]) => ({ ...stock(), symbol, nearMiss: item.invalidated===true, guardReasons: item.invalidated ? ['Trend invalidated'] : [] })) }));
vi.mock('../src/lib/riskGuards', async importOriginal => ({ ...await importOriginal<typeof import('../src/lib/riskGuards')>(), applyInstitutionalGuards: vi.fn(async (_mode, candidates) => candidates) }));
vi.mock('../src/lib/operations', async importOriginal => {
  const original = await importOriginal<typeof import('../src/lib/operations')>();
  return { ...original, withLease: vi.fn(async (_key, work) => work()), recordOperation: mocks.operation };
});
import { getCachedScan, refreshScan, SCAN_VERSION } from '../src/lib/scanService';

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
afterEach(() => vi.useRealTimers());

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
it('all-provider failure preserves the previous snapshot time and cards as unverified', async () => {
  mocks.snapshot = { version: SCAN_VERSION, stocks: [stock({ symbol: 'A' })], removedToday: [], generatedAt: new Date(+NOW - 3600000), expiresAt: new Date(0) };
  mocks.batch.mockResolvedValue(batch([], ['A', 'B', 'C']));
  const result = await refreshScan('btst', 'All');
  expect(+result.generatedAt).toBe(+NOW - 3600000); expect(result.stocks[0].nearMiss).toBe(true);
  expect(result.status).toBe('unavailable'); expect(result.coverage?.processed).toBe(0);
});
it('recomputes sector concentration across successful batches', async () => {
  mocks.batch.mockResolvedValueOnce(batch(['A', 'B'])).mockResolvedValueOnce(batch(['C']));
  await refreshScan('swing_breakout', 'All');
  await vi.advanceTimersByTimeAsync(21000);
  const complete = await refreshScan('swing_breakout', 'All');
  expect(complete.stocks.filter(s => s.primaryRank)).toHaveLength(2);
  expect(complete.stocks.every(s => s.sectorCluster)).toBe(true);
});
it('legacy snapshots are viewable but cannot clear a new entry', async () => {
  mocks.snapshot = { version: 'old', stocks: [stock()], removedToday: [], generatedAt: NOW, expiresAt: new Date(+NOW + 3600000) };
  const cached = await getCachedScan('swing_breakout', 'All');
  expect(+cached!.expiresAt).toBe(0); expect(cached!.stocks[0].nearMiss).toBe(true);
  expect(cached!.stocks[0].guardReasons).toContain('Calculations need refreshing after engine update');
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

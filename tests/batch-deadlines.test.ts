import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bar, NOW } from './fixtures';
import { computeRVOL } from '../src/lib/relativeVolume';
import { calendarDay } from '../src/lib/timezone';
const mocks = vi.hoisted(() => ({ quote: vi.fn(), chart: vi.fn(), connect: vi.fn(), write: vi.fn(), cash:vi.fn() }));
vi.mock('yahoo-finance2', () => ({ default: class { quote = mocks.quote; chart = mocks.chart; } }));
vi.mock('../src/lib/db', () => ({ connectDB: mocks.connect }));
vi.mock('../src/lib/nseSessionData', async original => ({
  ...await original<object>(), getCashSession: mocks.cash, restoreCashSpecialSessions: async (_:string, bars:unknown[]) => bars
}));
vi.mock('../src/lib/models/StockCache', () => ({ StockCache: { findOne: () => ({ maxTimeMS: () => ({ lean: async () => null }) }), updateOne: mocks.write } }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); vi.resetModules(); mocks.quote.mockReset(); mocks.chart.mockReset(); mocks.connect.mockReset().mockRejectedValue(new Error('offline fixture')); mocks.write.mockReset(); mocks.cash.mockReset().mockResolvedValue(new Map()); });
afterEach(() => vi.useRealTimers());
const candles = Array.from({ length: 25 }, (_, i) => bar(new Date(Date.UTC(2026, 9, i + 1)).toISOString()));
const quote = { regularMarketPrice: 100, regularMarketTime: NOW, exchangeDataDelayedBy: 0 };

it('keeps only completed continuous-session 15m candles using dated CAS eligibility', async () => {
  const closeTime = new Date('2026-11-18T15:40:00+05:30');
  vi.setSystemTime(closeTime);
  mocks.quote.mockResolvedValue({ ...quote, regularMarketTime: closeTime });
  const start = new Date('2026-11-18T09:15:00+05:30');
  const today = Array.from({ length: 26 }, (_, index) =>
    bar(new Date(+start + index * 900000).toISOString(), 100 + index)
  );
  const priorAuction = bar('2026-11-17T15:15:00+05:30');
  const preOpen = bar('2026-11-18T09:00:00+05:30');
  mocks.chart.mockResolvedValue({ quotes: [priorAuction, preOpen, ...today] });
  const { batchFetchStockData } = await import('../src/lib/dataFetcher');
  const instruments = new Map([['CAS.NS', { casEligible: true }], ['REGULAR.NS', { casEligible: false }]]);
  const batch = await batchFetchStockData(['CAS.NS', 'REGULAR.NS', 'UNKNOWN.NS'], '15m', false, false, undefined, undefined, {
    sessionInstruments: Promise.resolve(instruments)
  });
  expect(batch.get('CAS.NS')?.candles).toEqual(today.slice(0, 24));
  expect(batch.get('UNKNOWN.NS')?.candles).toEqual(today.slice(0, 24));
  expect(batch.get('REGULAR.NS')?.candles).toEqual(today.slice(0, 25));
  expect(batch.get('CAS.NS')?.currentPrice).toBe(100);
});

it('refreshes 15m history at candle close so a cached forming volume cannot become final', async () => {
  const prior = bar('2026-11-17T15:00:00+05:30');
  const current = bar('2026-11-18T09:15:00+05:30', 100, 30);
  const beforeClose = new Date('2026-11-18T09:29:00+05:30');
  const afterClose = new Date('2026-11-18T09:31:00+05:30');
  vi.setSystemTime(beforeClose);
  mocks.chart
    .mockResolvedValueOnce({ quotes: [prior, current], meta: { regularMarketTime: beforeClose } })
    .mockResolvedValueOnce({ quotes: [prior, { ...current, volume: 350 }], meta: { regularMarketTime: afterClose } });
  const { fetchHistoricalCandles } = await import('../src/lib/dataFetcher');
  expect(await fetchHistoricalCandles('A.NS', '15m')).toEqual([prior]);
  vi.setSystemTime(afterClose);
  expect((await fetchHistoricalCandles('A.NS', '15m')).at(-1)?.volume).toBe(350);
  expect(mocks.chart).toHaveBeenCalledTimes(2);
});

it('preserves provider-reported split evidence from a 15m chart response', async () => {
  const split = new Date('2026-11-18T09:15:00+05:30');
  const intraday = bar('2026-11-18T09:30:00+05:30',50);
  mocks.chart.mockResolvedValue({quotes:[intraday], events:{splits:[{date:split}]}});
  const {fetchHistoricalCandles} = await import('../src/lib/dataFetcher');
  expect(await fetchHistoricalCandles('A.NS','15m')).toEqual([{...intraday,splitReported:true}]);
});

it('preserves a non-CAS closing-slot RVOL only with dated comparable history', async () => {
  const now = new Date('2026-11-19T15:40:00+05:30');
  vi.setSystemTime(now);
  const days = Array.from({length:19}, (_, i) => String(i+1).padStart(2,'0'))
    .map(day => '2026-11-' + day).filter(day => calendarDay(day).trading && day !== '2026-11-08').slice(-11);
  const history = days.flatMap(day => {
    const open = +new Date(day+'T09:15:00+05:30');
    return Array.from({length:25}, (_, slot) => bar(new Date(open + slot * 900000).toISOString()));
  });
  mocks.chart.mockResolvedValue({quotes:history});
  mocks.quote.mockResolvedValue({...quote,regularMarketTime:new Date('2026-11-19T15:30:00+05:30')});
  const {batchFetchStockData} = await import('../src/lib/dataFetcher');
  const options = {sessionInstruments: Promise.resolve(new Map([['A.NS',{casEligible:false}]]))};
  const run = (historicalCasEligibility?: ReadonlyMap<string, ReadonlyMap<string, boolean>>) =>
    batchFetchStockData(['A.NS'],'15m',false,false,undefined,undefined,{...options,historicalCasEligibility});
  const unknown = (await run()).get('A.NS')!;
  const verified = (await run(new Map([['A.NS',new Map(days.slice(0,-1).map(day=>[day,false]))]]))).get('A.NS')!;
  const volume = (data: typeof unknown) => computeRVOL(data.candles,null,true,data.dataQuality?.quoteAt,now,false);
  expect(volume(unknown)).toBeNull();
  expect(unknown.intradayVolumeNote).toMatch(/historical CAS eligibility/);
  expect(volume(verified)).toMatchObject({value:1,volume:2500,averageVolume:2500});
});

it('uses the official close for a pre-open morning quote even when Yahoo has a bar for that date', async () => {
  vi.setSystemTime(new Date('2026-11-19T08:00:00+05:30'));
  const prior = bar('2026-11-17T09:15:00+05:30',100);
  const provisional = bar('2026-11-18T09:15:00+05:30',105);
  const final = bar('2026-11-18T09:15:00+05:30',110,200);
  mocks.quote.mockResolvedValue({...quote,regularMarketPrice:105,regularMarketTime:new Date('2026-11-18T10:00:00+05:30')});
  mocks.chart.mockResolvedValue({quotes:[...candles,prior,provisional]});
  const {batchFetchStockData} = await import('../src/lib/dataFetcher');
  const unverified = (await batchFetchStockData(['A.NS'])).get('A.NS');
  expect(unverified?.dataQuality?.stale).toBe(true);
  mocks.cash.mockResolvedValue(new Map([['A.NS',{candle:final,previousClose:100}]]));
  const verified = (await batchFetchStockData(['A.NS'])).get('A.NS');
  expect(verified).toMatchObject({currentPrice:110,quoteVolume:200,dayChange:10,dataQuality:{stale:false,quoteSource:'NSE EOD',candleSource:'NSE EOD'}});
  expect(verified?.candles.at(-1)).toEqual(final);
});

it('does not reuse a forming daily candle after the close', async () => {
  vi.setSystemTime(new Date('2026-11-18T15:34:00+05:30'));
  const partial = bar('2026-11-18T09:15:00+05:30',105);
  const final = bar('2026-11-18T09:15:00+05:30',110,200);
  mocks.chart.mockResolvedValueOnce({quotes:[partial]}).mockResolvedValueOnce({quotes:[final]});
  const {fetchHistoricalCandles} = await import('../src/lib/dataFetcher');
  expect((await fetchHistoricalCandles('A.NS','1d')).at(-1)).toEqual(partial);
  vi.setSystemTime(new Date('2026-11-18T15:36:00+05:30'));
  expect((await fetchHistoricalCandles('A.NS','1d')).at(-1)).toEqual(final);
  expect(mocks.chart).toHaveBeenCalledTimes(2);
});

it('fetches confirmation for non-CAS BTST while CAS securities are in auction', async () => {
  const now = new Date('2026-11-18T15:20:00+05:30');
  vi.setSystemTime(now);
  const confirmation = [bar('2026-11-18T14:45:00+05:30'),bar('2026-11-18T15:00:00+05:30')];
  mocks.chart.mockImplementation(async (_symbol, params) => ({
    quotes: params.interval === '15m' ? confirmation : [...candles,bar('2026-11-17T09:15:00+05:30')]
  }));
  mocks.quote.mockResolvedValue({...quote,regularMarketTime:now});
  const {batchFetchStockData} = await import('../src/lib/dataFetcher');
  const batch = await batchFetchStockData(['CAS.NS','REGULAR.NS'],'1d',false,false,undefined,undefined,{
    withBtstConfirmation:true,
    sessionInstruments:Promise.resolve(new Map([['CAS.NS',{casEligible:true}],['REGULAR.NS',{casEligible:false}]]))
  });
  expect(batch.get('REGULAR.NS')?.confirmationCandles).toEqual(confirmation);
  expect(batch.get('REGULAR.NS')?.dataQuality).toMatchObject({stale:false});
  expect(batch.get('CAS.NS')?.confirmationCandles).toEqual([]);
  expect(batch.get('CAS.NS')?.dataQuality).toMatchObject({stale:true});
});

it('a hung warm-up cannot consume the batch and prevent all stock work', async () => {
  mocks.quote.mockImplementation(async symbol => symbol === '^NSEI' ? new Promise(() => {}) : quote);
  mocks.chart.mockResolvedValue({ quotes: candles });
  const { batchFetchStockData } = await import('../src/lib/dataFetcher');
  const work = batchFetchStockData(['A.NS'], '1d', false, false, Date.now() + 30000);
  await vi.advanceTimersByTimeAsync(2600);
  const result = await work;
  expect(result.has('A.NS')).toBe(true); expect(result.coverage.attempted).toEqual(['A.NS']);
});
it('hung symbol calls terminate and distinguish attempted failures from deferred symbols', async () => {
  mocks.quote.mockImplementation(async symbol => symbol === '^NSEI' ? quote : new Promise(() => {}));
  mocks.chart.mockImplementation(() => new Promise(() => {}));
  const { batchFetchStockData } = await import('../src/lib/dataFetcher');
  const symbols = Array.from({ length: 10 }, (_, i) => `${i}.NS`);
  const work = batchFetchStockData(symbols, '1d', false, false, Date.now() + 5000);
  await vi.advanceTimersByTimeAsync(5001); const result = await work;
  expect(result.size).toBe(0); expect(result.coverage.attempted).toHaveLength(6);
  expect(result.coverage.failed).toHaveLength(6); expect(result.coverage.deferred).toHaveLength(4);
  // Let bounded detached read-only SDK attempts expire; they cannot commit results.
  await vi.advanceTimersByTimeAsync(18000); expect(result.size).toBe(0);
});
it('slow optional cache writes cannot accumulate after their waiters time out', async () => {
  mocks.connect.mockResolvedValue(undefined);
  mocks.quote.mockResolvedValue(quote); mocks.chart.mockResolvedValue({ quotes: candles });
  const releases: Array<() => void> = [];
  mocks.write.mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
  const { batchFetchStockData } = await import('../src/lib/dataFetcher');
  const work = batchFetchStockData(Array.from({ length: 20 }, (_, i) => `${i}.NS`), '1d', false, false, Date.now() + 10000);
  await vi.advanceTimersByTimeAsync(2000);
  const result = await work;
  expect(result.size).toBe(20); expect(mocks.write).toHaveBeenCalledTimes(2);
  releases.forEach(release => release());
});

import { batchFetchStockData } from './dataFetcher';
import { runScreener, type ScreenerMode, type ScreenedStock } from './screenerEngine';
import { NSE_SCAN_UNIVERSE } from './niftyStocks';
import { getMarketRegime } from './marketRegime';
import { applyInstitutionalGuards } from './riskGuards';
import { AppError } from './operations';
import { getInstrumentMaster, instrumentMap } from './marketReference';
import { beforeDeadline } from './deadline';
import { getSectorBenchmarks, usesSectorBenchmark } from './sectorBenchmarks';
import { getNseEventReports } from './nseCorporateEvents';
import { getNseSurveillanceReports } from './nseSurveillance';
import { getNsePriceBands } from './nsePriceBands';
export const MODES: ScreenerMode[] = ['intraday','btst','swing_breakout','swing_pullback','positional','longterm'];
export function validMode(value: unknown): ScreenerMode {
  if (typeof value !== 'string' || !MODES.includes(value as ScreenerMode)) throw new AppError('INVALID_MODE', 'Choose a valid strategy.', 400);
  return value as ScreenerMode;
}
export function validSymbol(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('INVALID_SYMBOL','NSE symbol required.',400);
  const symbol = value.trim().toUpperCase().replace(/\.NS$/, '');
  if (!/^[A-Z0-9&-]{1,25}$/.test(symbol)) throw new AppError('INVALID_SYMBOL','Enter a valid NSE symbol.',400);
  return `${symbol}.NS`;
}
const requests = new Map<string, Promise<ScreenedStock>>();
export async function resolveStock(symbol: string, mode: ScreenerMode): Promise<ScreenedStock> {
  const key = `${symbol}:${mode}`;
  const running = requests.get(key); if (running) return running;
  const work = (async()=>{
    const deadline=Date.now()+23000;
    const instrumentsPromise = getInstrumentMaster().then(instrumentMap);
    const [data,market,instruments,benchmarks,events,surveillance,priceBands] = await Promise.all([
      batchFetchStockData([symbol], mode==='intraday'?'15m':'1d', mode==='positional'||mode==='longterm', mode!=='intraday',deadline,undefined,{
        withBtstConfirmation: mode === 'btst',
        sessionInstruments: instrumentsPromise
      }),
      beforeDeadline(getMarketRegime,deadline),
      instrumentsPromise,
      usesSectorBenchmark(mode)?beforeDeadline(getSectorBenchmarks, Date.now()+5200).catch(()=>[]):[],
      beforeDeadline(getNseEventReports, Date.now()+4500).catch(()=>undefined),
      beforeDeadline(getNseSurveillanceReports, Date.now()+4500).catch(()=>undefined),
      beforeDeadline(getNsePriceBands, Date.now()+4500).catch(()=>new Map())
    ]);
    const item = data.get(symbol);
    if (!item) throw new AppError('DATA_UNAVAILABLE', 'Sufficient verified market data is unavailable for this symbol.', 422);
    item.sector = NSE_SCAN_UNIVERSE.find(s=>s.symbol===symbol)?.sector ?? 'Unknown';
    item.sectorBenchmark = benchmarks.find(itemBenchmark=>itemBenchmark.sector===item.sector);
    const result = await applyInstitutionalGuards(mode, runScreener(mode,data), data, market,deadline,instruments,{events,surveillance,priceBands});
    if (!result[0]) throw new AppError('INSUFFICIENT_HISTORY', 'Not enough candles for this strategy.', 422);
    return result[0];
  })().finally(()=>requests.delete(key));
  requests.set(key,work); return work;
}

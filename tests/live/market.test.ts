import { it,expect,vi } from 'vitest';
import { mkdir,writeFile } from 'node:fs/promises';
vi.mock('../../src/lib/db',()=>({connectDB:vi.fn().mockRejectedValue(new Error('Read-only live probe: database writes disabled'))}));
import { batchFetchStockData } from '../../src/lib/dataFetcher';
import { runScreener,type ScreenerMode } from '../../src/lib/screenerEngine';
import { NSE_SCAN_UNIVERSE } from '../../src/lib/niftyStocks';
import { getMarketRegime } from '../../src/lib/marketRegime';
import { applyInstitutionalGuards } from '../../src/lib/riskGuards';
it.skipIf(process.env.LIVE_MARKET_TEST!=='1')('read-only real Yahoo pipeline',async()=>{
  const symbols=['RELIANCE.NS','HDFCBANK.NS'];
  const daily=await batchFetchStockData(symbols,'1d',true,true,Date.now()+35000);
  const intra=await batchFetchStockData(symbols,'15m',false,false,Date.now()+35000);
  for(const map of [daily,intra])for(const [symbol,data]of map)data.sector=NSE_SCAN_UNIVERSE.find(s=>s.symbol===symbol)?.sector??'Unknown';
  const regime=await getMarketRegime(),modes:ScreenerMode[]=['intraday','btst','swing_breakout','swing_pullback','positional','longterm'];
  const results=[];
  for(const mode of modes){const map=mode==='intraday'?intra:daily;const screened=await applyInstitutionalGuards(mode,runScreener(mode,map),map,regime);results.push({mode,processed:map.size,stocks:screened.map(s=>({symbol:s.symbol,nearMiss:s.nearMiss,guardReasons:s.guardReasons,dataQuality:s.dataQuality,eventStatus:s.eventStatus,earningsDate:s.earningsDate,monthlyTrend:s.monthlyTrend,annualYears:s.fundamentals.annualHistory?.length??0}))});}
  await mkdir('audit/2026-11-18',{recursive:true});
  await writeFile('audit/2026-11-18/live-readonly.json',JSON.stringify({at:new Date(),readOnly:true,aiCalls:0,regime,results},null,2));
  expect(daily.size).toBeGreaterThan(0);
  expect([...daily.values()].every(s=>Boolean(s.dataQuality))).toBe(true);
},120000);

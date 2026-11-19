import { stock } from './fixtures';
import type { ScreenerMode,ScreenedStock } from '../src/lib/screenerEngine';
const modes:ScreenerMode[]=['intraday','btst','swing_breakout','swing_pullback','positional','longterm'];
const risks:Array<{name:string;patch:Partial<ScreenedStock>}>= [
  {name:'near-miss',patch:{nearMiss:true}},
  {name:'earnings-blackout',patch:{earningsRisk:true}},
  {name:'stale-feed',patch:{dataQuality:{quoteAt:null,candleAt:null,fetchedAt:'2026-11-18T00:00:00Z',delayMinutes:null,stale:true,incompleteCandle:false,issues:['Stale fixture']}}},
  {name:'missing-liquidity',patch:{liquidityPass:false}},
  {name:'invalid-plan',patch:{defaultSL:1050}},
];
export const benchmarkCases=modes.flatMap(mode=>risks.map(risk=>({name:`${mode}/${risk.name}`,stock:stock({symbol:'SYNTHETIC.NS',name:'Synthetic evaluation only',mode,...risk.patch})})));

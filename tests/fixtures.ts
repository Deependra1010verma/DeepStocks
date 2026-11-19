import type { ScreenedStock } from '../src/lib/screenerEngine';
import type { OHLCV } from '../src/lib/indicators';
export const NOW = new Date('2026-11-18T10:35:00+05:30');
export function bar(date: string, close=100, volume=100): OHLCV {return {date:new Date(date),open:close,high:close,low:close,close,volume};}
export function stock(overrides: Partial<ScreenedStock> = {}): ScreenedStock {
  return {symbol:'ALPHA.NS',name:'ALPHA test fixture',sector:'IT',mode:'swing_breakout',cmp:1000,dayChange:10,dayChangePercent:1,rsi:60,rvol:2,atr:20,ema20:980,ema50:950,ema200:900,macdLine:2,macdSignal:1,vwap:990,volume:1e6,quantScore:80,defaultSL:970,target1:1040,target2:1080,extensionRatio:1,vwapExtensionRatio:0.5,extensionWarning:false,weeklyTrend:'BULLISH',breakoutDaysAgo:0,sectorBoost:0,positionRiskPercent:1,liquidityPass:true,eventStatus:'known',regime:'NEUTRAL',guardReasons:[],dataQuality:{quoteAt:'2026-11-18T05:00:00Z',candleAt:'2026-11-18T03:45:00Z',fetchedAt:NOW.toISOString(),delayMinutes:15,stale:false,incompleteCandle:true,issues:[]},fundamentals:{revenueGrowth:null,earningsGrowth:null,returnOnEquity:null,debtToEquity:null,profitMargins:null,forwardPE:null,marketCap:null,earningsDate:null,corporateEventDate:null,corporateEventType:null,source:'unavailable'},candles:Array.from({length:70},(_,i)=>bar(new Date(Date.UTC(2026,8,i+1,3,45)).toISOString(),950+i,1e6)),...overrides};
}

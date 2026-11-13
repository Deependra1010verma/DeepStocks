// Quick debug script to check why screener returns no results
// Run: node scripts/debug-scan.mjs

import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance();

const TEST_SYMBOLS = ["RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS"];

async function main() {
  console.log("\n=== DAILY (Swing) candles test ===");
  for (const sym of TEST_SYMBOLS) {
    try {
      const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const hist = await yf.historical(sym, { period1: startDate, interval: "1d" });
      const q = await yf.quote(sym);
      const closes = hist.map(h => h.close);
      const lastClose = closes.at(-1) ?? 0;
      const vol20Avg = hist.slice(-20).reduce((s, h) => s + (h.volume ?? 0), 0) / 20;
      const todayVol = q.regularMarketVolume ?? hist.at(-1)?.volume ?? 0;
      const rvol = vol20Avg > 0 ? todayVol / vol20Avg : 1;
      const dayChangePct = q.regularMarketChangePercent ?? 0;
      
      // Simple EMA20 (last value approx)
      const k = 2 / 21;
      let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      for (let i = 20; i < closes.length; i++) ema20 = closes[i] * k + ema20 * (1 - k);
      
      // RSI (approximate last 14)
      const changes = closes.slice(-15).map((c, i, arr) => i === 0 ? 0 : c - arr[i-1]);
      const gains = changes.slice(1).filter(c => c > 0).reduce((a, b) => a + b, 0) / 14;
      const losses = changes.slice(1).filter(c => c < 0).map(c => Math.abs(c)).reduce((a, b) => a + b, 0) / 14;
      const rsi = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);

      const high20 = Math.max(...hist.slice(-20).map(h => h.high ?? 0));
      const breakout = lastClose > high20 * 0.98;

      console.log(`\n${sym}:`);
      console.log(`  Price: ₹${lastClose.toFixed(1)} | DayChg: ${dayChangePct.toFixed(2)}%`);
      console.log(`  RSI~${rsi.toFixed(0)} | RVOL: ${rvol.toFixed(2)}x | EMA20: ₹${ema20.toFixed(0)}`);
      console.log(`  Candles: ${hist.length} | Vol today: ${todayVol.toLocaleString()} | Vol20avg: ${vol20Avg.toFixed(0)}`);
      console.log(`  Price>EMA20: ${lastClose > ema20} | Breakout20d: ${breakout}`);
      console.log(`  SWING_BO filter would pass: price>EMA20=${lastClose>ema20}, RVOL>=1.5=${rvol>=1.5}, RSI>55=${rsi>55}`);
    } catch (e) {
      console.log(`  ${sym}: ERROR - ${e.message}`);
    }
  }

  console.log("\n=== INTRADAY (15m) candles test ===");
  const sym = "RELIANCE.NS";
  try {
    const startDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const result = await yf.chart(sym, { period1: startDate, interval: "15m" });
    const quotes = result?.quotes ?? [];
    console.log(`${sym}: ${quotes.length} 15m candles fetched`);
    if (quotes.length > 0) {
      const last = quotes.at(-1);
      console.log(`  Last candle: open=${last?.open?.toFixed(0)} close=${last?.close?.toFixed(0)} vol=${last?.volume}`);
    }
    // Check if market is open/weekend
    const now = new Date();
    const day = now.getDay();
    const hour = now.getHours();
    console.log(`\n  Current time: ${now.toLocaleString("en-IN")} (day=${day})`);
    if (day === 0 || day === 6) console.log("  ⚠️  WEEKEND — NSE is closed, intraday data = 0 volume");
    else if (hour < 9 || hour >= 16) console.log("  ⚠️  MARKET CLOSED — outside 9:15–15:30 IST, volume data stale");
    else console.log("  ✅ Market hours");
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}

main().catch(console.error);

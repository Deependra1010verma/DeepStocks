import { NextResponse } from "next/server";
import { fetchHistoricalCandles } from "@/lib/dataFetcher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Pick one representative stock per sector to gauge sector performance
const SECTOR_REPRESENTATIVES: Record<string, string> = {
  Banking: "HDFCBANK.NS",
  IT: "TCS.NS",
  FMCG: "HINDUNILVR.NS",
  Energy: "RELIANCE.NS",
  Auto: "MARUTI.NS",
  Pharma: "SUNPHARMA.NS",
  Materials: "TATASTEEL.NS",
  Infrastructure: "LT.NS",
  NBFC: "BAJFINANCE.NS",
  Insurance: "SBILIFE.NS",
  Telecom: "BHARTIARTL.NS",
  Healthcare: "APOLLOHOSP.NS",
  Consumer: "TITAN.NS",
  Utilities: "NTPC.NS",
  "Capital Goods": "BEL.NS",
  "Real Estate": "DLF.NS",
  Internet: "ZOMATO.NS",
  Electronics: "DIXON.NS",
  Retail: "TRENT.NS",
  Media: "SUNTV.NS",
};

export async function GET() {
  try {
    const sectorPerformance: Array<{ sector: string; changePercent: number; representative: string }> = [];
    const period1 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const CONCURRENCY = 5;
    const entries = Object.entries(SECTOR_REPRESENTATIVES);

    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const chunk = entries.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async ([sector, symbol]) => {
          try {
            const candles = await fetchHistoricalCandles(symbol, "1d", period1);
            if (candles.length < 2) return;
            const latest = candles[candles.length - 1];
            const prev = candles[candles.length - 2];
            const changePct = ((latest.close - prev.close) / prev.close) * 100;
            sectorPerformance.push({ sector, changePercent: parseFloat(changePct.toFixed(2)), representative: symbol });
          } catch {
            // skip on error
          }
        })
      );
      if (i + CONCURRENCY < entries.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    sectorPerformance.sort((a, b) => b.changePercent - a.changePercent);
    const top3 = sectorPerformance.slice(0, 3);
    const bottom3 = sectorPerformance.slice(-3);

    return NextResponse.json({
      topSectors: top3,
      weakSectors: bottom3,
      allSectors: sectorPerformance,
      updatedAt: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

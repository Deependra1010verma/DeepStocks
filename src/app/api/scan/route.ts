import { NextRequest, NextResponse } from "next/server";
import { NSE_SCAN_UNIVERSE } from "@/lib/niftyStocks";
import { batchFetchStockData } from "@/lib/dataFetcher";
import { runScreener, ScreenerMode } from "@/lib/screenerEngine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const mode: ScreenerMode = body.mode ?? "swing_breakout";
    const sectorFilter: string | null = body.sector ?? null;

    let stocks = NSE_SCAN_UNIVERSE;
    if (sectorFilter && sectorFilter !== "All") {
      stocks = NSE_SCAN_UNIVERSE.filter((s) => s.sector === sectorFilter);
    }

    const symbols = stocks.map((s) => s.symbol);
    const withFundamentals = mode === "positional" || mode === "longterm";
    const withWeekly = mode !== "intraday";
    const interval = mode === "intraday" ? "15m" : "1d";

    const stockDataMap = await batchFetchStockData(symbols, interval, withFundamentals, withWeekly);

    // Inject sector info
    for (const [sym, data] of stockDataMap) {
      const meta = NSE_SCAN_UNIVERSE.find((s) => s.symbol === sym);
      if (meta) {
        data.sector = meta.sector;
      }
    }

    const screened = runScreener(mode, stockDataMap);

    // Inject sector into screened results
    const enriched = screened.map((s) => {
      const meta = NSE_SCAN_UNIVERSE.find((m) => m.symbol === s.symbol);
      return { ...s, sector: meta?.sector ?? "Unknown" };
    });

    return NextResponse.json({ stocks: enriched, count: enriched.length, mode });
  } catch (error) {
    console.error("Scan error:", error);
    return NextResponse.json({ error: "Scan failed", details: String(error) }, { status: 500 });
  }
}

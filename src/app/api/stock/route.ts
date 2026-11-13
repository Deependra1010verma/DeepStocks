import { NextRequest, NextResponse } from "next/server";
import { NSE_SCAN_UNIVERSE } from "@/lib/niftyStocks";
import { batchFetchStockData } from "@/lib/dataFetcher";
import { runScreener, ScreenerMode } from "@/lib/screenerEngine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function normalizeSymbol(value: string): string {
  const cleaned = value.trim().toUpperCase().replace(/\s+/g, "");
  return cleaned.endsWith(".NS") ? cleaned : `${cleaned}.NS`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = typeof body.symbol === "string" ? body.symbol : "";
    if (!input) return NextResponse.json({ error: "NSE symbol required" }, { status: 400 });

    const symbol = normalizeSymbol(input);
    if (!/^[A-Z0-9&-]+\.NS$/.test(symbol)) {
      return NextResponse.json({ error: "Use a valid NSE symbol such as TATASTEEL or HAL" }, { status: 400 });
    }

    const mode = (body.mode ?? "swing_breakout") as ScreenerMode;
    const withFundamentals = mode === "positional" || mode === "longterm";
    const interval = mode === "intraday" ? "15m" : "1d";
    const stockData = await batchFetchStockData([symbol], interval, withFundamentals, mode !== "intraday");
    const data = stockData.get(symbol);
    if (!data) return NextResponse.json({ error: `No market data found for ${symbol.replace(".NS", "")}` }, { status: 404 });

    const meta = NSE_SCAN_UNIVERSE.find((stock) => stock.symbol === symbol);
    data.sector = meta?.sector ?? "Search result";
    const screened = runScreener(mode, new Map([[symbol, data]]));
    const stock = screened[0];
    if (!stock) return NextResponse.json({ error: "Not enough candles to build a stock snapshot" }, { status: 422 });

    return NextResponse.json({ stock: { ...stock, sector: data.sector }, mode });
  } catch (error) {
    console.error("Stock search error:", error);
    return NextResponse.json({ error: "Stock lookup failed", details: String(error) }, { status: 500 });
  }
}

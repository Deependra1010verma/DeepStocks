import { NextResponse } from "next/server";
import { fetchHistoricalCandles } from "@/lib/dataFetcher";
import { calcEMA } from "@/lib/indicators";
import { getMarketSession } from "@/lib/timezone";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

export async function GET() {
  const session = getMarketSession();
  try {
    const candles = await fetchHistoricalCandles("^NSEI", "1d",
      new Date(Date.now() - 120 * 24 * 60 * 60 * 1000)
    );

    if (candles.length < 55) {
      return NextResponse.json({ regime: "NEUTRAL", niftyClose: null, ema20: null, ema50: null, session });
    }

    const closes = candles.map((c) => c.close);
    const ema20Arr = calcEMA(closes, 20);
    const ema50Arr = calcEMA(closes, 50);
    const niftyClose = closes[closes.length - 1];
    const ema20 = ema20Arr[ema20Arr.length - 1];
    const ema50 = ema50Arr[ema50Arr.length - 1];

    let regime: "BULLISH" | "NEUTRAL" | "BEARISH";
    if (niftyClose > ema20 && ema20 > ema50) {
      regime = "BULLISH";
    } else if (niftyClose < ema20 && niftyClose >= ema50) {
      regime = "NEUTRAL";
    } else {
      regime = "BEARISH";
    }

    return NextResponse.json({
      regime,
      niftyClose: niftyClose.toFixed(2),
      ema20: ema20.toFixed(2),
      ema50: ema50.toFixed(2),
      session,
      message: regime === "BEARISH"
        ? "⚠️ Market in Bearish Regime — Use Half Position Sizing"
        : regime === "NEUTRAL"
        ? "Market in Neutral Zone — Wait for Confirmation"
        : "✅ Market in Bullish Regime — Setups are Valid",
    });
  } catch (error) {
    console.error("Market mood error:", error);
    return NextResponse.json({ regime: "NEUTRAL", session, error: "Failed to fetch market data" }, { status: 500 });
  }
}

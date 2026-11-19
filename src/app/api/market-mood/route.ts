import { requireOwner, apiError } from '@/lib/apiSecurity';
import { NextRequest, NextResponse } from "next/server";
import { getMarketRegime } from "@/lib/marketRegime";
import { getMarketSession } from "@/lib/timezone";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const session = getMarketSession();
  try {
    requireOwner(req);
    const market = await getMarketRegime();
    return NextResponse.json({
      regime: market.regime,
      available: market.available,
      niftyClose: market.niftyClose?.toFixed(2) ?? null,
      ema20: market.niftyEma20?.toFixed(2) ?? null,
      ema50: market.niftyEma50?.toFixed(2) ?? null,
      indiaVix: market.indiaVix?.toFixed(2) ?? null,
      defensiveMode: market.defensiveMode,
      riskMultiplier: market.riskMultiplier,
      positionRiskPercent: market.positionRiskPercent,
      regimeReason: market.reason,
      session,
      message: !market.available ? 'Nifty/VIX data unavailable or stale — no new risk cleared' : market.regime === "BEARISH"
        ? "⚠️ Market in Bearish Regime — Use Half Position Sizing"
        : market.regime === "NEUTRAL"
        ? "Market in Neutral Zone — Wait for Confirmation"
        : "Index trend bullish; stock guards still apply",
    });
  } catch (error) {
    return apiError(error);
  }
}

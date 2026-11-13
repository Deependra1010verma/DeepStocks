import { NextRequest, NextResponse } from "next/server";
import { analyzeStock } from "@/lib/aiAnalyst";
import { fetchNews } from "@/lib/dataFetcher";
import { ScreenedStock } from "@/lib/screenerEngine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const hasGeminiKey = Object.entries(process.env).some(([name, value]) =>
      /^(GEMINI_API_KEY|GEMINI_API_KEY_\d+)$/.test(name) && Boolean(value?.trim())
    );

    if (!hasGeminiKey) {
      return NextResponse.json(
        { error: "No Gemini API key is configured. Add GEMINI_API_KEY_1 (or GEMINI_API_KEY) to .env.local." },
        { status: 400 }
      );
    }

    const body = await req.json();
    const stock: ScreenedStock = body.stock;
    const marketRegime: "BULLISH" | "NEUTRAL" | "BEARISH" = body.marketRegime ?? "NEUTRAL";

    if (!stock || !stock.symbol) {
      return NextResponse.json({ error: "Stock data required" }, { status: 400 });
    }

    const news = await fetchNews(stock.symbol);
    const analysis = await analyzeStock(stock, news, marketRegime);

    return NextResponse.json({ analysis, news });
  } catch (error) {
    console.error("Analyze error:", error);
    return NextResponse.json({ error: "Analysis failed", details: String(error) }, { status: 500 });
  }
}

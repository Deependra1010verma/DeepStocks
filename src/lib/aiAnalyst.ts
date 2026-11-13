import { Type } from "@google/genai";
import { ScreenedStock } from "./screenerEngine";
import { NewsItem } from "./dataFetcher";
import { withGeminiKey } from "./geminiKeyPool";

// Best available model — use gemini-2.5-flash
const MODEL = "gemini-2.5-flash";

export interface AIAnalysisResult {
  convictionScore: number;
  verdictBadge: "STRONG BUY SETUP" | "BUY ON DIP" | "WATCHLIST ONLY" | "AVOID - HIGH RISK";
  executiveSummary: string;
  tradePlan: {
    entryZone: string;
    stopLoss: string;
    stopLossReason: string;
    target1: string;
    target2: string;
    riskRewardRatio: string;
    holdingPeriod: string;
  };
  technicalBreakdown: string[];
  fundamentalCheck: string[];
  newsAndCatalysts: string[];
  keyRisksAndTraps: string[];
  riskFlags?: string[];
}

const MODE_RULES: Record<ScreenedStock["mode"], string> = {
  intraday: "Intraday only: use the 15-minute candle context, VWAP, current-session RVOL and same-day risk. Do not describe a multi-week holding thesis.",
  btst: "BTST only: focus on today's close, gap/overnight risk and the next trading session. Do not present it as a multi-week swing.",
  swing_breakout: "Swing breakout only: use a 2–4 week horizon, daily breakout structure and weekly trend confirmation. Do not use intraday VWAP commentary as the primary thesis.",
  swing_pullback: "Swing pullback only: use a 2–4 week horizon, daily EMA pullback/reclaim and weekly trend. Do not mix in same-day intraday execution language.",
  positional: "Positional only: use a 1–3 month horizon, daily plus weekly trend and fundamentals. Do not frame this as an intraday trade.",
  longterm: "Long-term only: use a 1–5 year horizon, quality/fundamental context and weekly trend. Do not give intraday entry language.",
};

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    convictionScore: { type: Type.NUMBER, description: "Score 1-10" },
    verdictBadge: {
      type: Type.STRING,
      enum: ["STRONG BUY SETUP", "BUY ON DIP", "WATCHLIST ONLY", "AVOID - HIGH RISK"],
    },
    executiveSummary: { type: Type.STRING },
    tradePlan: {
      type: Type.OBJECT,
      properties: {
        entryZone:      { type: Type.STRING },
        stopLoss:       { type: Type.STRING },
        stopLossReason: { type: Type.STRING },
        target1:        { type: Type.STRING },
        target2:        { type: Type.STRING },
        riskRewardRatio:{ type: Type.STRING },
        holdingPeriod:  { type: Type.STRING },
      },
      required: ["entryZone", "stopLoss", "stopLossReason", "target1", "target2", "riskRewardRatio", "holdingPeriod"],
    },
    technicalBreakdown: { type: Type.ARRAY, items: { type: Type.STRING } },
    fundamentalCheck:   { type: Type.ARRAY, items: { type: Type.STRING } },
    newsAndCatalysts:   { type: Type.ARRAY, items: { type: Type.STRING } },
    keyRisksAndTraps:   { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    "convictionScore", "verdictBadge", "executiveSummary", "tradePlan",
    "technicalBreakdown", "fundamentalCheck", "newsAndCatalysts", "keyRisksAndTraps",
  ],
};

export async function analyzeStock(
  stock: ScreenedStock,
  news: NewsItem[],
  marketRegime: "BULLISH" | "NEUTRAL" | "BEARISH"
): Promise<AIAnalysisResult> {
  const stockMetrics = {
    symbol: stock.symbol.replace(".NS", ""),
    name: stock.name,
    tradingMode: stock.mode,
    nearMiss: Boolean(stock.nearMiss),
    marketRegime,
    price: {
      cmp: stock.cmp.toFixed(2),
      dayChange: `${stock.dayChangePercent.toFixed(2)}%`,
      vwap: stock.vwap.toFixed(2),
    },
    technicals: {
      rsi14: stock.rsi.toFixed(1),
      ema20: stock.ema20.toFixed(2),
      ema50: stock.ema50.toFixed(2),
      ema200: stock.ema200.toFixed(2),
      atr14: stock.atr.toFixed(2),
      rvol: Math.min(stock.rvol, 9.99).toFixed(2),
      macdLine: stock.macdLine.toFixed(3),
      macdSignal: stock.macdSignal.toFixed(3),
      quantScore: stock.quantScore,
      weeklyTrend: stock.weeklyTrend,
      extensionRatio: stock.extensionRatio.toFixed(2),
      vwapExtensionRatio: stock.vwapExtensionRatio.toFixed(2),
      extensionWarning: stock.extensionWarning,
      breakoutDaysAgo: stock.breakoutDaysAgo,
    },
    fundamentals: {
      revenueGrowth: stock.fundamentals.revenueGrowth !== null
        ? `${(stock.fundamentals.revenueGrowth * 100).toFixed(1)}%` : "N/A",
      earningsGrowth: stock.fundamentals.earningsGrowth !== null
        ? `${(stock.fundamentals.earningsGrowth * 100).toFixed(1)}%` : "N/A",
      roe: stock.fundamentals.returnOnEquity !== null
        ? `${(stock.fundamentals.returnOnEquity * 100).toFixed(1)}%` : "N/A",
      debtToEquity: stock.fundamentals.debtToEquity?.toFixed(2) ?? "N/A",
      profitMargins: stock.fundamentals.profitMargins !== null
        ? `${(stock.fundamentals.profitMargins * 100).toFixed(1)}%` : "N/A",
      forwardPE: stock.fundamentals.forwardPE?.toFixed(1) ?? "N/A",
      marketCap: stock.fundamentals.marketCap !== null
        ? `₹${(stock.fundamentals.marketCap / 1e7).toFixed(0)} Cr` : "N/A",
      source: stock.fundamentals.source,
    },
    suggestedLevels: {
      stopLoss: stock.defaultSL.toFixed(2),
      target1: stock.target1.toFixed(2),
      target2: stock.target2.toFixed(2),
    },
    recentNews: news.slice(0, 5).map((n) => n.title),
  };

  const systemInstruction = `You are a conservative Senior Institutional Equity Analyst specializing in NSE/BSE India.
The requested mode is ${stock.mode}. ${MODE_RULES[stock.mode]}
Use ONLY the provided numbers — do not invent data or fill N/A fundamentals with assumptions.
If nearMiss is true, do not call it a qualified setup.
If RVOL is below 1.2, explicitly say volume confirmation is missing and use WATCHLIST ONLY.
If extensionWarning is true, explicitly say "Extended Move — Wait for Pullback, Do Not Chase" and do not recommend a fresh market entry.
If weeklyTrend is BEARISH for a swing/positional/long-term mode, explain the conflict and keep conviction conservative.
Give sharp, evidence-based analysis: why it passed or missed, timeframe-appropriate entry/stop/targets, bull/bear case.
Write in English. Keep each point concise (1-2 sentences max).`;

  const response = await withGeminiKey((ai) =>
    ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(stockMetrics, null, 2) }],
        },
      ],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.3,
      },
    })
  );

  const text = response.text ?? "{}";
  try {
    return enforceRiskGuards(JSON.parse(text) as AIAnalysisResult, stock);
  } catch {
    // Fallback: extract JSON from response if wrapped in markdown
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return enforceRiskGuards(JSON.parse(match[0]) as AIAnalysisResult, stock);
    throw new Error("Failed to parse AI response as JSON");
  }
}

function enforceRiskGuards(analysis: AIAnalysisResult, stock: ScreenedStock): AIAnalysisResult {
  const riskFlags: string[] = [];
  const fundamentalsMissing = [
    stock.fundamentals.revenueGrowth,
    stock.fundamentals.earningsGrowth,
    stock.fundamentals.returnOnEquity,
    stock.fundamentals.debtToEquity,
    stock.fundamentals.profitMargins,
    stock.fundamentals.forwardPE,
    stock.fundamentals.marketCap,
  ].every((value) => value === null);
  if (stock.nearMiss) riskFlags.push("Near miss — this stock did not clear every screener condition.");
  if (stock.rvol < 1.2) riskFlags.push("Awaiting volume — RVOL is below 1.2x.");
  if (stock.extensionWarning) riskFlags.push("Extended Move — Wait for Pullback, Do Not Chase.");
  if ((stock.mode === "positional" || stock.mode === "longterm") && fundamentalsMissing) {
    riskFlags.push("Fundamentals unavailable — quality checks are incomplete.");
  }
  if (stock.weeklyTrend === "BEARISH" && stock.mode !== "intraday" && stock.mode !== "btst") {
    riskFlags.push("Weekly trend is bearish — higher-timeframe confirmation is missing.");
  }

  const score = Math.max(1, Math.min(10, Math.round(Number(analysis.convictionScore) || 1)));
  const guarded = riskFlags.length > 0;
  return {
    ...analysis,
    convictionScore: guarded ? Math.min(score, 6) : score,
    verdictBadge: guarded && analysis.verdictBadge !== "AVOID - HIGH RISK"
      ? "WATCHLIST ONLY"
      : analysis.verdictBadge,
    riskFlags,
  };
}

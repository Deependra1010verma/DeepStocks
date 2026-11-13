import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: "AIzaSyDWePP3skdRIP2sLUDlXiIlVx_U6bRjvC0",
  httpOptions: { apiVersion: "v1beta" },
});

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    convictionScore: { type: Type.NUMBER },
    verdictBadge: { type: Type.STRING, enum: ["STRONG BUY SETUP","BUY ON DIP","WATCHLIST ONLY","AVOID - HIGH RISK"] },
    executiveSummary: { type: Type.STRING },
    tradePlan: {
      type: Type.OBJECT,
      properties: {
        entryZone: { type: Type.STRING }, stopLoss: { type: Type.STRING },
        stopLossReason: { type: Type.STRING }, target1: { type: Type.STRING },
        target2: { type: Type.STRING }, riskRewardRatio: { type: Type.STRING },
        holdingPeriod: { type: Type.STRING },
      },
      required: ["entryZone","stopLoss","stopLossReason","target1","target2","riskRewardRatio","holdingPeriod"],
    },
    technicalBreakdown: { type: Type.ARRAY, items: { type: Type.STRING } },
    fundamentalCheck: { type: Type.ARRAY, items: { type: Type.STRING } },
    newsAndCatalysts: { type: Type.ARRAY, items: { type: Type.STRING } },
    keyRisksAndTraps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["convictionScore","verdictBadge","executiveSummary","tradePlan","technicalBreakdown","fundamentalCheck","newsAndCatalysts","keyRisksAndTraps"],
};

console.log("Testing v1beta with systemInstruction + responseSchema...");
try {
  const r = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: '{"symbol":"BLUESTARCO","cmp":1800,"rsi":62,"ema20":1780,"ema50":1750}' }] }],
    config: {
      systemInstruction: "You are an NSE stock analyst. Analyze the stock and return JSON.",
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.3,
    },
  });
  const parsed = JSON.parse(r.text ?? "{}");
  console.log("✅ SUCCESS!");
  console.log("  Verdict:", parsed.verdictBadge);
  console.log("  Score:", parsed.convictionScore);
  console.log("  Summary:", parsed.executiveSummary?.slice(0, 80));
} catch (e) {
  console.error("❌ FAILED:", e.message);
}

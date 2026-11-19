import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY_1;
if (!apiKey) throw new Error("Set GEMINI_API_KEY or GEMINI_API_KEY_1 before running this script");
const ai = new GoogleGenAI({ apiKey });

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    convictionScore: { type: Type.NUMBER },
    verdictBadge: { type: Type.STRING, enum: ["STRONG BUY SETUP", "BUY ON DIP", "WATCHLIST ONLY", "AVOID - HIGH RISK"] },
    executiveSummary: { type: Type.STRING },
    tradePlan: {
      type: Type.OBJECT,
      properties: {
        entryZone: { type: Type.STRING }, stopLoss: { type: Type.STRING },
        stopLossReason: { type: Type.STRING }, target1: { type: Type.STRING },
        target2: { type: Type.STRING }, riskRewardRatio: { type: Type.STRING },
        holdingPeriod: { type: Type.STRING },
      },
      required: ["entryZone", "stopLoss", "stopLossReason", "target1", "target2", "riskRewardRatio", "holdingPeriod"],
    },
    technicalBreakdown: { type: Type.ARRAY, items: { type: Type.STRING } },
    fundamentalCheck: { type: Type.ARRAY, items: { type: Type.STRING } },
    newsAndCatalysts: { type: Type.ARRAY, items: { type: Type.STRING } },
    keyRisksAndTraps: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["convictionScore", "verdictBadge", "executiveSummary", "tradePlan", "technicalBreakdown", "fundamentalCheck", "newsAndCatalysts", "keyRisksAndTraps"],
};

console.log("Testing Gemini response schema...");
try {
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    contents: [{ role: "user", parts: [{ text: '{"symbol":"BLUESTARCO","cmp":1800}' }] }],
    config: {
      systemInstruction: "Analyze this Indian stock and return JSON.",
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.3,
    },
  });
  console.log("✅ Schema works. Response length:", response.text?.length ?? 0);
} catch (e) {
  console.error("❌ Schema test failed:", e.message ?? e);
}

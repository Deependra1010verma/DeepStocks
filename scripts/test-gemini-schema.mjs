import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "AIzaSyDWePP3skdRIP2sLUDlXiIlVx_U6bRjvC0" });

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    convictionScore: { type: Type.NUMBER },
    verdictBadge: { type: Type.STRING, enum: ["STRONG BUY SETUP", "BUY ON DIP", "WATCHLIST ONLY", "AVOID - HIGH RISK"] },
    executiveSummary: { type: Type.STRING },
    tradePlan: {
      type: Type.OBJECT,
      properties: {
        entryZone: { type: Type.STRING },
        stopLoss: { type: Type.STRING },
        stopLossReason: { type: Type.STRING },
        target1: { type: Type.STRING },
        target2: { type: Type.STRING },
        riskRewardRatio: { type: Type.STRING },
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

// Test 1: Try gemini-2.5-flash
console.log("Testing gemini-2.5-flash with responseSchema...");
try {
  const r = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: '{"symbol":"BLUESTARCO.NS","cmp":1800}' }] }],
    config: {
      systemInstruction: "Analyze this Indian stock. Return JSON.",
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.3,
    },
  });
  console.log("✅ gemini-2.5-flash works. Response length:", r.text?.length);
} catch (e) {
  console.error("❌ gemini-2.5-flash failed:", e.message);
  
  // Test 2: Try gemini-1.5-flash as fallback
  console.log("\nTrying gemini-1.5-flash...");
  try {
    const r2 = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: [{ role: "user", parts: [{ text: '{"symbol":"BLUESTARCO.NS","cmp":1800}' }] }],
      config: {
        systemInstruction: "Analyze this Indian stock. Return JSON.",
        responseMimeType: "application/json",
        responseSchema,
        temperature: 0.3,
      },
    });
    console.log("✅ gemini-1.5-flash works. Response length:", r2.text?.length);
  } catch (e2) {
    console.error("❌ gemini-1.5-flash also failed:", e2.message);
  }
}

// List available models
console.log("\nListing models...");
try {
  const models = await ai.models.list();
  for await (const m of models) {
    if (m.name?.includes("gemini")) console.log(" -", m.name, m.supportedActions);
  }
} catch (e) {
  console.error("Cannot list models:", e.message);
}

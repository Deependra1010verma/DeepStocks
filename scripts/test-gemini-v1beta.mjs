import { GoogleGenAI, Type } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY_1;
if (!apiKey) throw new Error("Set GEMINI_API_KEY or GEMINI_API_KEY_1 before running this script");

const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    convictionScore: { type: Type.NUMBER },
    verdictBadge: { type: Type.STRING },
    executiveSummary: { type: Type.STRING },
  },
  required: ["convictionScore", "verdictBadge", "executiveSummary"],
};

console.log("Testing v1beta with responseSchema...");
try {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: '{"symbol":"BLUESTARCO","cmp":1800}' }] }],
    config: {
      systemInstruction: "You are an NSE stock analyst. Analyze the stock and return JSON.",
      responseMimeType: "application/json",
      responseSchema,
      temperature: 0.3,
    },
  });
  console.log("✅ v1beta works. Response length:", response.text?.length ?? 0);
} catch (e) {
  console.error("❌ v1beta failed:", e.message ?? e);
}

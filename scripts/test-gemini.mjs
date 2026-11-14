import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY_1;
if (!apiKey) throw new Error("Set GEMINI_API_KEY or GEMINI_API_KEY_1 before running this script");

const ai = new GoogleGenAI({ apiKey });

try {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "Say hello in one line." }] }],
  });
  console.log("✅ Gemini works:", response.text);
} catch (e) {
  console.error("❌ Gemini error:", e.message ?? e);
}

import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: "AIzaSyDWePP3skdRIP2sLUDlXiIlVx_U6bRjvC0" });

try {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: "Say hello in one line." }] }],
  });
  console.log("✅ Gemini works:", response.text);
} catch (e) {
  console.error("❌ Gemini error:", e.message ?? e);
}

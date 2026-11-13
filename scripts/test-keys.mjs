// Quick test: ping each Gemini API key with a minimal request
import { readFileSync } from "fs";
import { resolve } from "path";

// Parse .env.local manually
const envPath = resolve(process.cwd(), ".env.local");
const envText = readFileSync(envPath, "utf-8");
const keys = [];
for (const line of envText.split("\n")) {
  const m = line.match(/^GEMINI_API_KEY_(\d+)=(.+)$/);
  if (m) keys.push({ index: m[1], key: m[2].trim() });
}

console.log(`Testing ${keys.length} keys...\n`);

async function testKey({ index, key }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "Say OK" }] }],
    generationConfig: { maxOutputTokens: 5 },
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();

    if (res.ok) {
      console.log(`✅ KEY_${index} — VALID (${res.status})`);
      return "ok";
    } else {
      const code = data?.error?.code;
      const msg  = data?.error?.message ?? JSON.stringify(data);
      if (code === 429) {
        console.log(`⚠️  KEY_${index} — QUOTA EXHAUSTED (429): ${msg.slice(0, 80)}`);
        return "quota";
      } else {
        console.log(`❌ KEY_${index} — INVALID/ERROR (${code}): ${msg.slice(0, 100)}`);
        return "invalid";
      }
    }
  } catch (e) {
    console.log(`❌ KEY_${index} — NETWORK ERROR: ${e.message}`);
    return "error";
  }
}

const results = [];
for (const k of keys) {
  const status = await testKey(k);
  results.push({ ...k, status });
  await new Promise(r => setTimeout(r, 500)); // small delay between requests
}

console.log("\n── Summary ──");
const invalid = results.filter(r => r.status === "invalid" || r.status === "error");
if (invalid.length === 0) {
  console.log("All keys are valid (some may be quota-exhausted but structurally correct).");
} else {
  console.log("Keys to REMOVE:");
  for (const r of invalid) console.log(`  GEMINI_API_KEY_${r.index} (value withheld)`);
}

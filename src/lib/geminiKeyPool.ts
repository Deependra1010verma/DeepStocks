/**
 * Gemini API Key Pool — Round-robin fallback rotator.
 *
 * How it works:
 * - Reads all GEMINI_API_KEY_1 .. GEMINI_API_KEY_N from env (gaps are allowed)
 * - On each call, tries the current key
 * - If quota is exhausted (429 / RESOURCE_EXHAUSTED), marks it and rotates to next
 * - Wraps around: after last key, starts from first
 * - If ALL keys are exhausted, throws a clear error
 *
 * This runs server-side only (Node.js process memory — survives across requests
 * within a single dev-server or single serverless warm instance).
 */

import { GoogleGenAI } from "@google/genai";

// ── Load all keys from env ─────────────────────────────────────────────────
function loadKeys(): string[] {
  const keys: string[] = [];
  // Support both GEMINI_API_KEY (single) and GEMINI_API_KEY_1..N (pool)
  const configured: Array<[number, string | undefined]> = [
    [0, process.env.GEMINI_API_KEY],
    ...Object.entries(process.env)
      .map(([name, value]) => {
        const match = name.match(/^GEMINI_API_KEY_(\d+)$/);
        return match ? [Number(match[1]), value] as [number, string | undefined] : null;
      })
      .filter((entry): entry is [number, string | undefined] => entry !== null)
      .sort(([a], [b]) => a - b),
  ];

  for (const [, value] of configured) {
    const key = value?.trim();
    if (key && key !== "your_gemini_api_key_here" && !keys.includes(key)) {
      keys.push(key); // avoid duplicates if single == key_1
    }
  }

  return keys;
}

// ── Pool state (module-level singleton) ───────────────────────────────────
const KEYS = loadKeys();
if (KEYS.length === 0) throw new Error("No GEMINI_API_KEY found in environment");

// Track exhaustion time per key (ms timestamp when it was marked exhausted)
// Reset after 24h so keys auto-recover after daily quota resets at midnight
const EXHAUSTED_UNTIL: Map<string, number> = new Map();
const QUOTA_RESET_MS = 24 * 60 * 60 * 1000; // 24 hours

let currentIndex = 0; // which key we're currently using

function isExhausted(key: string): boolean {
  const until = EXHAUSTED_UNTIL.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    EXHAUSTED_UNTIL.delete(key); // auto-recover after 24h
    return false;
  }
  return true;
}

function markExhausted(key: string) {
  EXHAUSTED_UNTIL.set(key, Date.now() + QUOTA_RESET_MS);
  console.warn(`[GeminiPool] Key ...${key.slice(-6)} unavailable/exhausted — rotating to next`);
}

function getActiveKey(): string | null {
  // Try from currentIndex, wrap around, pick first non-exhausted
  for (let i = 0; i < KEYS.length; i++) {
    const idx = (currentIndex + i) % KEYS.length;
    if (!isExhausted(KEYS[idx])) {
      currentIndex = idx;
      return KEYS[idx];
    }
  }
  return null; // all exhausted
}

// ── Error detection ───────────────────────────────────────────────────────
function isQuotaError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("exceeded your current quota")
  );
}

function isCredentialError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("api key not valid") ||
    msg.includes("invalid api key") ||
    msg.includes("unauthenticated") ||
    msg.includes("permission_denied") ||
    msg.includes("status: 401") ||
    msg.includes("status: 403") ||
    msg.includes("401") ||
    msg.includes("403")
  );
}

// ── Main exported function ────────────────────────────────────────────────
/**
 * Runs a Gemini API call with automatic key rotation on quota errors.
 * Pass a callback that receives a GoogleGenAI instance and returns a Promise.
 *
 * @example
 * const result = await withGeminiKey((ai) =>
 *   ai.models.generateContent({ model: "gemini-2.5-flash", ... })
 * );
 */
export async function withGeminiKey<T>(
  fn: (ai: GoogleGenAI) => Promise<T>
): Promise<T> {
  const triedKeys = new Set<string>();

  while (true) {
    const key = getActiveKey();

    if (!key) {
      throw new Error(
        `All ${KEYS.length} Gemini API keys are unavailable or quota-exhausted. ` +
        `They reset after 24h (at midnight IST). Try again later.`
      );
    }

    if (triedKeys.has(key)) {
      // We've gone full circle without success — all exhausted
      throw new Error(
        `All ${KEYS.length} Gemini API keys are unavailable or quota-exhausted. Try again later.`
      );
    }

    triedKeys.add(key);

    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: { apiVersion: "v1beta" },
    });

    try {
      const result = await fn(ai);
      return result; // success — return immediately
    } catch (err) {
      if (isQuotaError(err) || isCredentialError(err)) {
        markExhausted(key);
        // Rotate to next key
        currentIndex = (currentIndex + 1) % KEYS.length;
        // Loop again with next key
        continue;
      }
      // Non-quota error — rethrow
      throw err;
    }
  }
}

/** Returns pool status — useful for debugging */
export function poolStatus() {
  return KEYS.map((k, i) => ({
    index: i + 1,
    keySuffix: `...${k.slice(-6)}`,
    exhausted: isExhausted(k),
    current: i === currentIndex,
  }));
}

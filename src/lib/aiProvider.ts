import { GoogleGenAI } from '@google/genai';
import { AppError, consumeBudget, recordOperation, withLease } from './operations';

export type Provider = 'groq' | 'gemini';
export function providerConfig(): { provider: Provider; model: string; configured: boolean; version: string } {
  const provider: Provider = process.env.AI_PROVIDER === 'gemini' ? 'gemini' : 'groq';
  const model = provider === 'groq' ? (process.env.GROQ_MODEL || 'openai/gpt-oss-120b') : (process.env.GEMINI_MODEL || 'gemini-3.8-flash');
  const configured = provider === 'groq' ? Boolean(process.env.GROQ_API_KEY?.trim()) : geminiKeys().length > 0;
  return { provider, model, configured, version: `${provider}:${model}` };
}
function geminiKeys(): string[] {
  return [...new Set(Object.entries(process.env).filter(([k,v]) => /^(GEMINI_API_KEY|GEMINI_API_KEY_\d+)$/.test(k) && v?.trim()).sort(([a],[b])=>a.localeCompare(b, undefined, {numeric:true})).map(([,v])=>v!.trim()))];
}
export function classifyProviderError(status: number, message: string, retryAfter = 60): AppError {
  if (status === 402 || /prepayment|billing|payment required/i.test(message)) return new AppError('AI_BILLING', 'AI provider billing/credits unavailable. Quant research remains available.', 503);
  if ([401,403].includes(status)) return new AppError('AI_CREDENTIALS', 'AI provider credential rejected. Check the server configuration.', 503);
  if (status === 404) return new AppError('AI_MODEL', 'Configured AI model is unavailable.', 503);
  if (status === 429) return new AppError('AI_RATE_LIMIT', 'AI provider quota reached. Please retry later.', 429, Math.min(3600, Math.max(1, retryAfter)));
  return new AppError('AI_UNAVAILABLE', 'AI provider temporarily unavailable. Quant research remains available.', 503);
}
const cooldowns = new Map<string, number>();
export async function generateJSON(system: string, input: unknown, schema: Record<string, unknown>): Promise<{ text: string; provider: Provider; model: string }> {
  const config = providerConfig();
  if (!config.configured) throw new AppError('AI_NOT_CONFIGURED', `Configure ${config.provider === 'groq' ? 'GROQ_API_KEY' : 'GEMINI_API_KEY'} to enable AI explanations.`);
  if (process.env.AI_FREE_ONLY !== 'false' && config.provider !== 'groq') throw new AppError('AI_FREE_ONLY', 'Free-only mode permits the configured Groq provider. Gemini requires an explicit server setting.');
  if (process.env.AI_FREE_ONLY !== 'false' && !['openai/gpt-oss-120b', 'openai/gpt-oss-20b'].includes(config.model)) throw new AppError('AI_MODEL', 'Model is not on the reviewed free-plan allowlist.');
  if ((cooldowns.get(config.version) ?? 0) > Date.now()) throw new AppError('AI_COOLDOWN', 'AI provider is cooling down. Quant research remains available.', 429, 60);
  const prompt = JSON.stringify(input), reservedTokens = Math.ceil((system.length + prompt.length) / 2) + 1800;
  return withLease(`provider:${config.provider}`, async () => {
    try {
      await consumeBudget('ai:requests', Number(process.env.AI_DAILY_REQUEST_LIMIT || 40), 86400000);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        throw new AppError('AI_DAILY_LIMIT', 'DeepStocks used its daily AI request budget. The budget resets at 05:30 IST.', 429, error.retryAfter);
      }
      throw error;
    }
    try {
      await consumeBudget(`ai:tokens:${config.provider}`, Math.min(Number(process.env.AI_DAILY_TOKEN_LIMIT || 150000), 200000), 86400000, reservedTokens);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        throw new AppError('AI_DAILY_LIMIT', 'DeepStocks used its daily AI token budget. The budget resets at 05:30 IST.', 429, error.retryAfter);
      }
      throw error;
    }
    try {
      await consumeBudget(`ai:minute:${config.provider}`, 8000, 60000, reservedTokens);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RATE_LIMITED') {
        throw new AppError('AI_MINUTE_LIMIT', 'DeepStocks used its current minute AI token budget.', 429, error.retryAfter);
      }
      throw error;
    }
    const start = Date.now();
    try {
      let text: string;
      if (config.provider === 'groq') {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.timeout(22000),
          headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, temperature: 0.2, max_completion_tokens: 1800, messages: [{role:'system',content:system},{role:'user',content:prompt}], response_format: {type:'json_schema',json_schema:{name:'stock_explanation',strict:true,schema}} }),
        });
        const body = await response.json();
        if (!response.ok) throw classifyProviderError(response.status, String(body.error?.message ?? ''), Number(response.headers.get('retry-after')) || 60);
        if (body.choices?.[0]?.finish_reason === 'length') throw new AppError('AI_TRUNCATED', 'AI response exceeded its output budget.');
        text = body.choices?.[0]?.message?.content ?? '';
      } else {
        // Only credential rejection permits another configured key. Rate/billing limits are project-level.
        const keys = geminiKeys(); let response;
        for (let i = 0; i < Math.min(keys.length, 2); i++) {
          try {
            const ai = new GoogleGenAI({ apiKey: keys[i], httpOptions: { timeout: 10000 } });
            response = await ai.models.generateContent({ model: config.model, contents: prompt, config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 1800, temperature: 0.2 } }); break;
          } catch (error) {
            const safe = classifyProviderError(Number((error as {status?:number}).status ?? 0), String(error));
            if (safe.code !== 'AI_CREDENTIALS' || i + 1 >= Math.min(keys.length, 2)) throw safe;
          }
        }
        text = response?.text ?? '';
      }
      await recordOperation('ai', { provider: config.provider, model: config.model, status: 'ok', latencyMs: Date.now()-start });
      return { text, provider: config.provider, model: config.model };
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('AI_UNAVAILABLE', 'AI request failed or timed out.');
      cooldowns.set(config.version, Date.now() + (safe.code === 'AI_BILLING' ? 300000 : (safe.retryAfter ?? 30)*1000));
      await recordOperation('ai', { provider: config.provider, model: config.model, status: safe.code, latencyMs: Date.now()-start });
      throw safe;
    }
  }, 55000);
}

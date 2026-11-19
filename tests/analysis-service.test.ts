import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ANALYSIS_VERSION, guardFingerprint } from '../src/lib/aiCachePolicy';
import { generateAndCache } from '../src/lib/analysisService';
import { NOW, stock } from './fixtures';

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(), read: vi.fn(), save: vi.fn(), lease: vi.fn()
}));
vi.mock('../src/lib/aiAnalyst', async original => ({
  ...await original<object>(), analyzeStock: mocks.analyze
}));
vi.mock('../src/lib/dataFetcher', () => ({fetchNews: async () => []}));
vi.mock('../src/lib/db', () => ({connectDB: async () => undefined}));
vi.mock('../src/lib/models/AIAnalysisCache', () => ({
  AIAnalysisCache: {findOne: () => ({lean: mocks.read}), updateOne: mocks.save}
}));
vi.mock('../src/lib/operations', async original => ({
  ...await original<object>(), withLease: mocks.lease
}));

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  vi.stubEnv('AI_PROVIDER', 'groq');
  vi.stubEnv('GROQ_MODEL', 'openai/gpt-oss-120b');
  mocks.analyze.mockReset().mockImplementation(async () => ({}));
  mocks.read.mockReset().mockResolvedValue(null);
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.lease.mockReset().mockImplementation(async (_key, work) => work());
});
afterEach(() => vi.useRealTimers());

it('coalesces identical inputs while binding changed input to its own evidence', async () => {
  const first = stock({nearMiss:false});
  const changed = stock({cmp:1100,nearMiss:true,guardReasons:['Upcoming earnings']});
  const [a, same, b] = await Promise.all([
    generateAndCache(first), generateAndCache(stock({nearMiss:false})), generateAndCache(changed)
  ]);
  expect(a).toBe(same);
  expect(b.stock).toBe(changed);
  expect(b.fingerprint).toBe(guardFingerprint(changed));
  expect(mocks.analyze).toHaveBeenCalledTimes(2);
  expect(new Set(mocks.lease.mock.calls.map(([key]) => key)).size).toBe(1);
});

it('reuses a report saved by another worker before the lease was acquired', async () => {
  const input = stock();
  mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce({
    version: ANALYSIS_VERSION, cachedCmp: input.cmp, fingerprint: guardFingerprint(input),
    provider: 'groq', modelId: 'openai/gpt-oss-120b', generatedAt: NOW,
    expiresAt: new Date(+NOW + 60000), analysis: {}
  });
  const result = await generateAndCache(input);
  expect(result).toMatchObject({cached:true,stock:input});
  expect(mocks.analyze).not.toHaveBeenCalled();
});

it('an explicit refresh bypasses the shared report cache', async () => {
  const result = await generateAndCache(stock(), true);
  expect(result.cached).toBe(false);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.analyze).toHaveBeenCalledOnce();
});

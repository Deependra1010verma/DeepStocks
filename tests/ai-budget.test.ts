import { afterEach, expect, it, vi } from 'vitest';

const reserve = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/operations', async original => ({
  ...await original<typeof import('../src/lib/operations')>(),
  consumeBudget: reserve,
  withLease: async (_key: string, work: () => Promise<unknown>) => work()
}));

import { generateJSON } from '../src/lib/aiProvider';
import { AppError } from '../src/lib/operations';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['ai:tokens:groq', 'AI_DAILY_LIMIT', 500],
  ['ai:minute:groq', 'AI_MINUTE_LIMIT', 10]
] as const)('reports the %s quota before contacting the model', async (key, code, seconds) => {
  vi.stubEnv('GROQ_API_KEY','fixture-key');
  vi.stubEnv('AI_PROVIDER','groq');
  vi.stubEnv('GROQ_MODEL','openai/gpt-oss-120b');
  reserve.mockImplementation(async name => {
    if (name === key) throw new AppError('RATE_LIMITED','Reserved budget exhausted',429,seconds);
  });
  const provider = vi.spyOn(globalThis,'fetch');
  try {
    await expect(generateJSON('test',{},{})).rejects.toMatchObject({ code,status:429,retryAfter:seconds });
    expect(provider).not.toHaveBeenCalled();
  } finally {
    provider.mockRestore();
  }
});

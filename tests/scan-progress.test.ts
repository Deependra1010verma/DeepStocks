import { afterEach, expect, it, vi } from 'vitest';
import { beforeDeadline } from '../src/lib/deadline';
import { advanceScanProgress, scanCoverage, startScanProgress } from '../src/lib/scanProgress';
afterEach(() => vi.useRealTimers());

it('a stalled dependency settles by deadline even if it ignores cancellation', async () => {
  vi.useFakeTimers(); let release!: (v: number) => void;
  const result = beforeDeadline(() => new Promise<number>(resolve => { release = resolve; }), Date.now() + 500);
  const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(501); await rejected; release(10);
  expect(vi.getTimerCount()).toBe(0);
});
it('canceled work is not started and successful work removes its timer', async () => {
  vi.useFakeTimers(); const controller = new AbortController(); controller.abort(); const work = vi.fn(async () => 1);
  await expect(beforeDeadline(work, Date.now() + 1000, controller.signal)).rejects.toThrow(); expect(work).not.toHaveBeenCalled();
  expect(await beforeDeadline(work, Date.now() + 1000)).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it('resumes pending symbols and keeps attempted failures distinct from deferred work', () => {
  const initial = startScanProgress(['A', 'B', 'C'], undefined, 10000);
  const first = advanceScanProgress(initial, ['A', 'B'], ['A']);
  expect(scanCoverage(first, 3)).toEqual({ requested: 3, attempted: 2, processed: 1, failed: ['B'], deferred: ['C'] });
  const resumed = startScanProgress(['A', 'B', 'C'], first, 30000);
  expect(resumed.deferred).toEqual(['C']);
  const complete = advanceScanProgress(resumed, ['C'], ['C']);
  expect(scanCoverage(complete, 3)).toMatchObject({ attempted: 3, processed: 2, failed: ['B'], deferred: [] });
});
it('expired cycles start again instead of carrying unlimited stale progress', () => {
  const old = advanceScanProgress(startScanProgress(['A', 'B'], undefined, 10000), ['A'], ['A']);
  const next = startScanProgress(['A', 'B'], old, 1000000);
  expect(next.processed).toEqual([]); expect(next.deferred).toEqual(['B', 'A']);
});

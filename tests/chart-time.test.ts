import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEffect, useRef } from 'react';
import { createChart, TickMarkType, type ChartOptions, type UTCTimestamp } from 'lightweight-charts';
import CandlestickChart from '../src/components/CandlestickChart';
import { bar } from './fixtures';

vi.mock('react', async original => ({
  ...await original<object>(),
  useRef: vi.fn(),
  useEffect: vi.fn(),
}));
vi.mock('lightweight-charts', async original => ({
  ...await original<object>(),
  createChart: vi.fn(),
}));

const setData = vi.fn();

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(useRef).mockReturnValueOnce({ current: { clientWidth: 600, clientHeight: 300 } });
  vi.mocked(useRef).mockReturnValueOnce({ current: null });
  vi.mocked(useEffect).mockImplementation(effect => { effect(); });
  vi.mocked(createChart).mockClear().mockReturnValue({
    addSeries: () => ({ setData }),
    timeScale: () => ({ fitContent() {} }),
  } as unknown as ReturnType<typeof createChart>);
  setData.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  { interval: '15m' as const, first: '2026-11-20T15:00:00+05:30', axis: /23 Nov.*09:15/, crosshair: /23 Nov 2026.*09:15 IST/ },
  { interval: '1d' as const, first: '2026-11-20T09:15:00+05:30', axis: /^23 Nov$/, crosshair: /^23 Nov 2026 IST$/ },
])('formats the $interval Monday bar in IST after a weekend', ({ interval, first, axis, crosshair }) => {
  const monday = bar('2026-11-23T09:15:00+05:30');
  const candles = [bar(first), monday];
  const props = { candles, interval, symbol: 'ALPHA.NS', ema20: 0, ema50: 0, ema200: 0 };
  CandlestickChart(props);

  const utc = (Date.parse('2026-11-23T03:45:00Z') / 1000) as UTCTimestamp;
  const options = vi.mocked(createChart).mock.calls[0][1] as Pick<ChartOptions, 'timeScale' | 'localization'>;
  expect(options.timeScale.tickMarkFormatter?.(utc, TickMarkType.DayOfMonth, 'en-IN')).toMatch(axis);
  expect(options.localization.timeFormatter?.(utc)).toMatch(crosshair);
  expect(setData.mock.calls[0][0][1].time).toBe(utc);
  expect(monday.date.toISOString()).toBe('2026-11-23T03:45:00.000Z');
});

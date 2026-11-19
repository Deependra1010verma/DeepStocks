import type { ScreenerMode } from './screenerEngine';
import type { ScanProgress } from './scanProgress';
import { isAutomationWindow, isLongTermEodWindow } from './timezone';
import { isBtstWindow } from './entrySignals';
const MOMENTUM_MODES: ScreenerMode[] = ['swing_breakout', 'swing_pullback', 'intraday'];
export const QUALITY_MODES: ScreenerMode[] = ['positional', 'longterm'];
export interface ScheduleRow {
  mode: ScreenerMode;
  expiresAt: Date;
  updatedAt: Date;
  version?: string;
  progress?: ScanProgress;
}
export function chooseScheduledMode(
  rows: ScheduleRow[],
  version: string,
  now = new Date()
): ScreenerMode | null {
  const inBtstWindow=isBtstWindow(now);
  const modes: ScreenerMode[] = isAutomationWindow(now)
    ? inBtstWindow ? ['btst', ...MOMENTUM_MODES] : MOMENTUM_MODES
    : isLongTermEodWindow(now) ? QUALITY_MODES : [];
  const byMode = new Map(rows.map((row) => [row.mode, row]));
  const due = modes.filter((mode) => {
    const row = byMode.get(mode);
    return !row || row.version !== version || +row.expiresAt <= +now;
  });
  if(due.includes('btst'))return 'btst';
  function continuation(mode: ScreenerMode) {
    const row = byMode.get(mode),
      start = Date.parse(row?.progress?.startedAt ?? '');
    return Number(
      row?.version === version &&
        Boolean(row.progress?.deferred.length) &&
        +now >= start &&
        +now - start < 15 * 60000
    );
  }
  return (
    due.sort(
      (a, b) =>
        continuation(b) - continuation(a) ||
        +(byMode.get(a)?.updatedAt ?? 0) - +(byMode.get(b)?.updatedAt ?? 0)
    )[0] ?? null
  );
}

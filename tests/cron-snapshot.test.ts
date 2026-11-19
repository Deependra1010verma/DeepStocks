import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { stock } from './fixtures';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  cached: vi.fn(),
  record: vi.fn(),
  alert: vi.fn(),
  warm: vi.fn()
}));
vi.mock('../src/lib/scanService', () => ({
  refreshScan: mocks.refresh,
  getCachedScan: mocks.cached,
  snapshotIsStale: () => false
}));
vi.mock('../src/lib/ledgerService', () => ({
  recordPaperSignal: mocks.record,
  updatePaperLedger: vi.fn()
}));
vi.mock('../src/lib/alertOutbox', () => ({ queueAlert: mocks.alert, deliverAlerts: vi.fn() }));
vi.mock('../src/lib/analysisService', () => ({ generateAndCache: mocks.warm }));
vi.mock('../src/lib/apiSecurity', () => ({ requireCron: vi.fn(), apiError: vi.fn() }));
vi.mock('../src/lib/db', () => ({ connectDB: vi.fn() }));
vi.mock('../src/lib/timezone', async (original) => ({
  ...(await original<typeof import('../src/lib/timezone')>()),
  isAutomationWindow: () => true
}));

import { GET } from '../src/app/api/cron/sync-eod/route';

it('keeps automated signals, setup alerts and model warming paused during partial coverage', async () => {
  const snapshot = {
    coverage: { requested: 259, processed: 120, verified: 120, failed: [], deferred: ['UNSCANNED.NS'] },
    stocks: [stock({ nearMiss: false, primaryRank: true, quantScore: 90 })]
  };
  mocks.refresh.mockResolvedValue(snapshot);
  mocks.cached.mockResolvedValue(snapshot);
  for (const task of ['scan', 'warm']) {
    const result = await GET(new NextRequest('http://localhost/api/cron/sync-eod?task=' + task));
    expect(await result.json()).toMatchObject({ skipped: true });
  }
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.alert).not.toHaveBeenCalled();
  expect(mocks.warm).not.toHaveBeenCalled();
});

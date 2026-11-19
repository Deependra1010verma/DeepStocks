import { NextRequest, NextResponse } from 'next/server';
import { apiError, requireCron } from '@/lib/apiSecurity';
import { connectDB } from '@/lib/db';
import { beforeDeadline } from '@/lib/deadline';
import { ScanSnapshot } from '@/lib/models/ScanSnapshot';
import { chooseScheduledMode, type ScheduleRow } from '@/lib/scanSchedule';
import { refreshScan, SCAN_VERSION } from '@/lib/scanService';
import { AppError, recordOperation, withLease } from '@/lib/operations';
import { isAutomationWindow, isLongTermEodWindow } from '@/lib/timezone';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(req: NextRequest) {
  const start = Date.now(),
    deadline = start + 27000;
  try {
    requireCron(req);
    if (!isAutomationWindow() && !isLongTermEodWindow())
      return NextResponse.json({ skipped: true, reason: 'Outside configured NSE window' });
    return await beforeDeadline(
      () =>
        withLease(
          'scheduler:scan-tick',
          async () => {
            await connectDB();
            const rows = await ScanSnapshot.find({ sector: 'All' })
              .select('mode expiresAt version progress updatedAt')
              .maxTimeMS(1000)
              .lean<ScheduleRow[]>();
            const mode = chooseScheduledMode(rows, SCAN_VERSION);
            if (!mode)
              return NextResponse.json({ skipped: true, reason: 'All eligible snapshots are fresh' });
            const result = await refreshScan(mode, 'All', deadline - 1500);
            const log = {
              mode,
              status: result.status,
              coverage: result.coverage,
              latencyMs: Date.now() - start
            };
            await beforeDeadline(
              () => recordOperation('scheduler:scan-tick', log),
              Math.min(deadline - 200, Date.now() + 500)
            ).catch(() => undefined);
            return NextResponse.json(log, { headers: { 'Cache-Control': 'no-store' } });
          },
          40000
        ),
      deadline
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'IN_PROGRESS')
      return NextResponse.json({ waiting: true, retryAfter: error.retryAfter });
    if (error instanceof Error && error.name === 'TimeoutError')
      return apiError(
        new AppError(
          'SCHEDULER_TIMEOUT',
          'Scan tick exceeded budget. A later tick can resume persisted progress.',
          504,
          60
        )
      );
    return apiError(error);
  }
}

import { REPORT_TTL_MS, type ReportStatus } from './nsePublicReports';
import type { ScreenedStock } from './screenerEngine';
import { dateToISTString, latestCompletedSession } from './timezone';

const REPORT_LABELS = {
  earnings: 'NSE financial results calendar',
  actions: 'NSE corporate-action calendar',
  asm: 'NSE ASM report',
  gsm: 'NSE GSM report'
} as const;

export type ReferenceCoverage = Partial<Record<keyof typeof REPORT_LABELS, ReportStatus>>;

export function referenceEntryReasons(stock: ScreenedStock, now = new Date()): string[] {
  if (stock.mode === 'longterm') return [];
  const reasons: string[] = [];
  const today = dateToISTString(now);
  if (!Number.isFinite(stock.tickSize) || !(Number(stock.tickSize) > 0) || stock.tickSizeAsOf !== today) {
    reasons.push('Current NSE instrument identity or tick size unverified');
  }
  for (const [key, label] of Object.entries(REPORT_LABELS)) {
    const report = stock.referenceCoverage?.[key as keyof ReferenceCoverage];
    const checked = Date.parse(report?.checkedAt ?? '');
    if (report?.status !== 'verified-empty' && report?.status !== 'verified-present') {
      reasons.push(label + ' unavailable');
    } else if (!(checked <= +now && +now - checked < REPORT_TTL_MS) ||
        dateToISTString(new Date(checked)) !== today) {
      reasons.push(label + ' needs a fresh check');
    }
  }
  const completed = latestCompletedSession(now), band = stock.exchangePriceBand;
  if (!band || !completed || !/^\d{4}-\d{2}-\d{2}$/.test(band.publishedDay) ||
      (band.percent !== null && !(Number.isFinite(band.percent) && band.percent > 0 && band.percent <= 100)) ||
      band.publishedDay < completed || band.publishedDay > today) {
    reasons.push('Current published NSE price-band reference unavailable');
  }
  return reasons;
}

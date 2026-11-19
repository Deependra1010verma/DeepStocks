const PUBLIC_NSE = 'https://www.nseindia.in';
type ReportPath =
  | '/api/event-calendar'
  | '/api/corporate-board-meetings?index=equities'
  | '/api/corporates-corporateActions?index=equities'
  | '/api/reportASM'
  | '/api/reportGSM';

export function nseReportUrl(path: ReportPath) {
  return PUBLIC_NSE + path;
}

export const REPORT_TTL_MS = 15 * 60_000;

export interface ReportStatus {
  status: 'verified-empty' | 'verified-present' | 'unavailable';
  checkedAt: string;
}

export function reportStatus(valid: boolean, count: number, checkedAt: Date): ReportStatus {
  return {status: !valid ? 'unavailable' : count ? 'verified-present' : 'verified-empty', checkedAt: checkedAt.toISOString()};
}

export function validReportRows(rows: unknown, validRow: (row: Record<string, unknown>) => boolean): boolean {
  return Array.isArray(rows) && rows.length <= 3000 &&
    rows.every(row => row && typeof row === 'object' && validRow(row));
}

export async function readNsePublicReport(path: ReportPath, filters?: URLSearchParams): Promise<unknown> {
  try {
    const url = new URL(nseReportUrl(path));
    filters?.forEach((value, key) => url.searchParams.set(key, value));
    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(4300),
      cache: 'no-store',
      redirect: 'error'
    });
    if (Number(response.headers.get('age')) * 1000 >= REPORT_TTL_MS) return null;
    const raw = await readBoundedReport(response, 512_000);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function readBoundedReport(response: Response, limit: number) {
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

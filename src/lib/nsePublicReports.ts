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

export async function readNsePublicReport(path: ReportPath): Promise<unknown> {
  try {
    const response = await fetch(nseReportUrl(path), {
      signal: AbortSignal.timeout(4300),
      redirect: 'error'
    });
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

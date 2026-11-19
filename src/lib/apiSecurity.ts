import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { AppError, consumeBudget } from './operations';
export const SESSION_COOKIE = 'deepstocks_session';
const SESSION_MS = 12 * 3600000;
function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32 || !process.env.APP_ACCESS_PASSWORD || process.env.APP_ACCESS_PASSWORD.length < 12) throw new AppError('ACCESS_NOT_CONFIGURED', 'Private access must be configured with APP_ACCESS_PASSWORD and SESSION_SECRET.');
  return value + process.env.APP_ACCESS_PASSWORD;
}
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function createSession(now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ user: 'owner', expires: now + SESSION_MS })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret()).update(payload).digest('base64url')}`;
}
export function validateSession(token: string | undefined, now = Date.now()): boolean {
  if (!token || token.length > 1000) return false;
  try {
    const [payload, signature, extra] = token.split('.');
    if (extra || !signature || !equalSecret(signature, createHmac('sha256', secret()).update(payload).digest('base64url'))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.user === 'owner' && Number.isFinite(data.expires) && data.expires > now && data.expires <= now + SESSION_MS;
  } catch { return false; }
}
export function requireOwner(req: NextRequest): string {
  secret();
  if (!validateSession(req.cookies.get(SESSION_COOKIE)?.value)) throw new AppError('UNAUTHORIZED', 'Sign in to your private dashboard.', 401);
  if (!['GET', 'HEAD'].includes(req.method)) {
    const origin = req.headers.get('origin');
    if (!origin || origin !== new URL(req.url).origin) throw new AppError('INVALID_ORIGIN', 'Request origin not allowed.', 403);
  }
  return 'owner';
}
export function requireCron(req: NextRequest): void {
  const configured = process.env.CRON_SECRET;
  const supplied = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!configured || !equalSecret(supplied, configured)) throw new AppError('UNAUTHORIZED', 'Unauthorized scheduler request.', 401);
}
export async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('content-length')) > 16384) throw new AppError('PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KB.', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new AppError('INVALID_REQUEST', 'JSON body required.', 400);
  let length = 0; const chunks: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 16384) { await reader.cancel(); throw new AppError('PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KB.', 413); } chunks.push(value); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new AppError('INVALID_REQUEST', 'Valid JSON object required.', 400); }
}
export function apiError(error: unknown) {
  const safe = error instanceof AppError ? error : new AppError('SERVICE_UNAVAILABLE', 'Service temporarily unavailable. Please retry shortly.');
  return NextResponse.json({ error: safe.message, code: safe.code }, { status: safe.status, headers: safe.retryAfter ? { 'Retry-After': String(safe.retryAfter), 'Cache-Control': 'no-store' } : { 'Cache-Control': 'no-store' } });
}
export async function authorizeRequest(req: NextRequest, route: string, limit = 30) {
  const owner = requireOwner(req); await consumeBudget(`api:${owner}:${route}`, limit, 60000); return owner;
}

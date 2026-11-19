import { NextRequest, NextResponse } from 'next/server';
import { apiError, createSession, equalSecret, readBody, SESSION_COOKIE, validateSession } from '@/lib/apiSecurity';
import { AppError, consumeBudget } from '@/lib/operations';
import { providerConfig } from '@/lib/aiProvider';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const authenticated=validateSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({ authenticated, configured: Boolean(process.env.APP_ACCESS_PASSWORD && process.env.SESSION_SECRET), ...(authenticated?{ai:providerConfig()}:{}) }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(req: NextRequest) {
  try {
    if (req.headers.get('origin') !== new URL(req.url).origin) throw new AppError('INVALID_ORIGIN', 'Request origin not allowed.', 403);
    await consumeBudget('login:global', 10, 60000);
    const body = await readBody(req), password = process.env.APP_ACCESS_PASSWORD;
    if (!password || !process.env.SESSION_SECRET) throw new AppError('ACCESS_NOT_CONFIGURED', 'Private access has not been configured on this server.');
    if (typeof body.password !== 'string' || !equalSecret(body.password, password)) throw new AppError('INVALID_PASSWORD', 'Incorrect password.', 401);
    const response = NextResponse.json({ authenticated: true, ai:providerConfig() });
    response.cookies.set(SESSION_COOKIE, createSession(), { httpOnly: true, secure: new URL(req.url).protocol === 'https:', sameSite: 'strict', path: '/', maxAge: 43200 });
    return response;
  } catch (error) { return apiError(error); }
}
export async function DELETE(req: NextRequest) {
  if (req.headers.get('origin') !== new URL(req.url).origin) return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  const response = NextResponse.json({ authenticated: false }); response.cookies.set(SESSION_COOKIE, '', { maxAge: 0, path: '/', httpOnly: true, sameSite: 'strict' }); return response;
}

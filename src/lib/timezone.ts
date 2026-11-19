// NSE cash-market calendar: NSE/CMTR/71775, 12 Dec 2025.
// Extend this reviewed calendar before enabling a new year; unknown dates fail closed.
const HOLIDAYS: Record<string, string> = {
  '2026-01-15': 'Maharashtra municipal election (NSE/CMTR/72260)',
  '2026-01-26': 'Republic Day', '2026-03-03': 'Holi',
  '2026-03-26': 'Ram Navami', '2026-03-31': 'Mahavir Jayanti',
  '2026-04-03': 'Good Friday', '2026-04-14': 'Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day', '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram', '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Gandhi Jayanti', '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali Balipratipada', '2026-11-24': 'Guru Nanak Jayanti',
  '2026-12-25': 'Christmas',
};
const SPECIAL_SESSIONS: Readonly<Record<string, { reason: string; preOpenStart: number; continuousStart: number }>> = {
  '2026-02-01': { reason: 'Budget Sunday (NSE/CMTR/72349)', preOpenStart: 540, continuousStart: 555 },
  '2026-11-08': { reason: 'Muhurat trading (NSE/CMTR/76941)', preOpenStart: 845, continuousStart: 860 }
};
export const CASH_SPECIAL_SESSIONS = Object.keys(SPECIAL_SESSIONS);
export const CALENDAR_VERSION = 'NSE-CM-2026-v3-CAS';
export function cashSessionLimits(day: string, casEligible: boolean | null = null) {
  const { preOpenStart, continuousStart } = SPECIAL_SESSIONS[day] ?? { preOpenStart: 540, continuousStart: 555 };
  if (day < '2026-08-03' || casEligible === false) return { preOpenStart, continuousStart, continuousEnd: 930, finalClose: 930 };
  // SEBI circular 23843/2026, paragraph 6.1, applies from 7 Dec 2026.
  return { preOpenStart, continuousStart, ...(day >= '2026-12-07' ? { continuousEnd: 930, finalClose: 945 } : { continuousEnd: 915, finalClose: 935 }) };
}
export function sessionTime(day: string, minute: number): Date {
  return new Date(+new Date(day + 'T00:00:00+05:30') + minute * 60_000);
}
const istDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });
export function dateToISTString(date: Date): string {
  return Number.isFinite(+date) ? istDateFormatter.format(date) : 'Invalid Date';
}
export function todayIST(): string { return dateToISTString(new Date()); }
export function minutesIST(date: Date): number {
  const shifted = new Date(date.getTime() + 19_800_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}
export function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}
export function calendarDay(date: string): { trading: boolean; verified: boolean; reason?: string } {
  if (!date.startsWith('2026-')) return { trading: false, verified: false, reason: 'Exchange calendar needs updating for this year' };
  if (SPECIAL_SESSIONS[date]) return { trading: true, verified: true, reason: SPECIAL_SESSIONS[date].reason };
  if (HOLIDAYS[date]) return { trading: false, verified: true, reason: HOLIDAYS[date] };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { trading: day !== 0 && day !== 6, verified: true, reason: day === 0 || day === 6 ? 'Weekend' : undefined };
}
export function isContinuous15mBar(date: Date, casEligible: boolean | null = null): boolean {
  const minute = minutesIST(date);
  const day = dateToISTString(date);
  const { continuousStart, continuousEnd } = cashSessionLimits(day, casEligible);
  return calendarDay(day).trading && +date % 60_000 === 0 && minute >= continuousStart &&
    (minute - continuousStart) % 15 === 0 && minute + 15 <= continuousEnd;
}
export type MarketSession = { state: 'PRE_OPEN' | 'LIVE' | 'CLOSED' | 'UNKNOWN'; label: string; message: string; timeIST: string; calendarVerified: boolean };
export function getMarketSession(now = new Date(), casEligible: boolean | null = null): MarketSession {
  const day = calendarDay(dateToISTString(now)), minutes = minutesIST(now);
  const timeIST = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} IST`;
  const base = { timeIST, calendarVerified: day.verified };
  if (!day.verified) return { ...base, state: 'UNKNOWN', label: 'SESSION UNVERIFIED', message: day.reason! };
  if (!day.trading) return { ...base, state: 'CLOSED', label: 'MARKET CLOSED', message: `${day.reason} — showing last available session` };
  // NSE cash CAS took effect 3 Aug 2026. Eligibility belongs to the dated
  // instrument master, not an inferred sector or a stale F&O list.
  const limits = cashSessionLimits(dateToISTString(now), casEligible);
  if (minutes >= limits.continuousEnd && minutes < limits.finalClose) {
    return { ...base, state: 'UNKNOWN', label: casEligible ? 'CLOSING AUCTION' : 'MIXED CLOSING SESSIONS', message: casEligible ? 'Closing auction; continuous-session entry rules are disabled' : 'CAS eligibility unverified; continuous entry disabled during mixed closing sessions' };
  }
  if (minutes >= limits.preOpenStart && minutes < limits.continuousStart) return { ...base, state: 'PRE_OPEN', label: 'PRE-OPEN', message: 'Auction prices are indicative until matched' };
  if (minutes >= limits.continuousStart && minutes < limits.continuousEnd) return { ...base, state: 'LIVE', label: 'MARKET OPEN', message: day.reason ?? 'NSE cash session open; quote freshness is shown separately' };
  return { ...base, state: 'CLOSED', label: 'MARKET CLOSED', message: 'Outside regular cash session; showing last available data' };
}
export function isMarketOpen(): boolean { return getMarketSession().state === 'LIVE'; }
export function nextMarketOpen(now = new Date()): Date {
  let day = dateToISTString(now);
  for (let i = 0; i < 370; i++, day = shiftDate(day, 1)) {
    const session = calendarDay(day);
    if (!session.verified) break;
    const open = sessionTime(day, cashSessionLimits(day).continuousStart);
    if (session.trading && open > now) return open;
  }
  return new Date(now.getTime() + 60_000);
}
export function latestCompletedSession(now = new Date(), casEligible: boolean | null = null): string | null {
  let day = dateToISTString(now);
  if (!calendarDay(day).verified) return null;
  const closeMinute = cashSessionLimits(day, casEligible).finalClose;
  if (minutesIST(now) < closeMinute) day = shiftDate(day, -1);
  for (let i = 0; i < 15; i++, day = shiftDate(day, -1)) if (calendarDay(day).trading) return day;
  return null;
}

// Yahoo labels historical weekly buckets by IST Monday. Keep a Sunday
// special session in the week it ends, and use the actual final session close.
export function isCompletedMarketPeriod(at: Date, interval: '1wk' | '1mo', now: Date): boolean {
  const day = dateToISTString(at), today = dateToISTString(now);
  if (day > today || !calendarDay(today).verified) return false;
  const date = new Date(day + 'T12:00:00Z');
  if (!Number.isFinite(+date)) return false;
  const weekday = (date.getUTCDay() + 6) % 7;
  const start = interval === '1wk' ? shiftDate(day, -weekday) : day.slice(0, 7) + '-01';
  let end = interval === '1wk' ? shiftDate(day, 6 - weekday)
    : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (end < today) return true;
  for (; end >= start; end = shiftDate(end, -1)) {
    const session = calendarDay(end);
    if (!session.verified) return false;
    if (session.trading) return now >= sessionTime(end, cashSessionLimits(end).finalClose);
  }
  return false;
}
export function tradingDaysAway(from: Date, to: Date): number | null {
  let day = dateToISTString(from); const end = dateToISTString(to);
  if (end < day || !calendarDay(day).verified) return null;
  let count = 0;
  for (let i = 0; day < end && i < 370; i++) {
    day = shiftDate(day, 1); const session = calendarDay(day);
    if (!session.verified) return null;
    if (session.trading) count++;
  }
  return day === end ? count : null;
}
// Existing automation is scheduled for regular sessions only.
export function isAutomationWindow(now = new Date()): boolean { return !SPECIAL_SESSIONS[dateToISTString(now)] && getMarketSession(now).state === 'LIVE' && minutesIST(now) >= 560; }
export function isLongTermEodWindow(now = new Date()): boolean { const day = dateToISTString(now); return !SPECIAL_SESSIONS[day] && calendarDay(day).trading && minutesIST(now) >= 945 && minutesIST(now) < 1020; }
export function isPreOpenWindow(now = new Date()): boolean { return !SPECIAL_SESSIONS[dateToISTString(now)] && getMarketSession(now).state === 'PRE_OPEN' && minutesIST(now) >= 552 && minutesIST(now) < 555; }

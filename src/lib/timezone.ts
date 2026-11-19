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
export const CALENDAR_VERSION = 'NSE-CM-2026-v2-CAS';
export function cashSessionLimits(day: string, casEligible: boolean | null = null) {
  if (day < '2026-08-03' || casEligible === false) return { continuousEnd: 930, finalClose: 930 };
  // SEBI circular 23843/2026, paragraph 6.1, applies from 7 Dec 2026.
  return day >= '2026-12-07' ? { continuousEnd: 930, finalClose: 945 } : { continuousEnd: 915, finalClose: 935 };
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
  if (date === '2026-11-08') return { trading: false, verified: false, reason: 'Muhurat session: special-session timings require verification' };
  if (HOLIDAYS[date]) return { trading: false, verified: true, reason: HOLIDAYS[date] };
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { trading: day !== 0 && day !== 6, verified: true, reason: day === 0 || day === 6 ? 'Weekend' : undefined };
}
export function isContinuous15mBar(date: Date, casEligible: boolean | null = null): boolean {
  const minute = minutesIST(date);
  if (!(minute >= 555) || +date % 900000 !== 0) return false;
  const day = dateToISTString(date);
  return calendarDay(day).trading && minute + 15 <= cashSessionLimits(day, casEligible).continuousEnd;
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
  if (minutes >= 540 && minutes < 555) return { ...base, state: 'PRE_OPEN', label: 'PRE-OPEN', message: 'Auction prices are indicative until matched' };
  if (minutes >= 555 && minutes < limits.continuousEnd) return { ...base, state: 'LIVE', label: 'MARKET OPEN', message: 'NSE cash session open; quote freshness is shown separately' };
  return { ...base, state: 'CLOSED', label: 'MARKET CLOSED', message: 'Outside regular cash session; showing last available data' };
}
export function isMarketOpen(): boolean { return getMarketSession().state === 'LIVE'; }
export function nextMarketOpen(now = new Date()): Date {
  let day = dateToISTString(now);
  for (let i = 0; i < 370; i++, day = shiftDate(day, 1)) {
    const open = new Date(`${day}T09:15:00+05:30`);
    if (calendarDay(day).trading && open > now) return open;
  }
  return new Date(now.getTime() + 60_000);
}
export function latestCompletedSession(now = new Date(), casEligible: boolean | null = null): string | null {
  let day = dateToISTString(now);
  const closeMinute = cashSessionLimits(day, casEligible).finalClose;
  if (minutesIST(now) < closeMinute) day = shiftDate(day, -1);
  for (let i = 0; i < 15; i++, day = shiftDate(day, -1)) if (calendarDay(day).trading) return day;
  return null;
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
export function isAutomationWindow(now = new Date()): boolean { return getMarketSession(now).state === 'LIVE' && minutesIST(now) >= 560; }
export function isLongTermEodWindow(now = new Date()): boolean { return calendarDay(dateToISTString(now)).trading && minutesIST(now) >= 945 && minutesIST(now) < 1020; }
export function isPreOpenWindow(now = new Date()): boolean { return getMarketSession(now).state === 'PRE_OPEN' && minutesIST(now) >= 552 && minutesIST(now) < 555; }

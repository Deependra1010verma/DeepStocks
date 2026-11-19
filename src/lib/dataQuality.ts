import { cashSessionLimits, dateToISTString, getMarketSession, latestCompletedSession, sessionTime } from './timezone';
interface SessionEligibility { day: string; casEligible: boolean }
export interface DataQuality { quoteAt: string | null; candleAt: string | null; fetchedAt: string; delayMinutes: number | null; stale: boolean; incompleteCandle: boolean; issues: string[]; quoteSource?: 'Yahoo' | 'NSE EOD'; candleSource?: 'Yahoo' | 'NSE EOD'; restoredCashSessions?: string[]; sessionEligibility?: SessionEligibility }
export function assessDataQuality(quoteAt: Date | string | null, candleAt: Date | string | null, delayMinutes: number | null, intraday: boolean, now = new Date(), eligibility?: SessionEligibility): DataQuality {
  const q = quoteAt ? new Date(quoteAt) : null, c = candleAt ? new Date(candleAt) : null;
  const validQ = q && Number.isFinite(q.getTime()) ? q : null, validC = c && Number.isFinite(c.getTime()) ? c : null;
  const day = dateToISTString(now);
  const cas = eligibility?.day === day ? eligibility.casEligible : null;
  const session = getMarketSession(now, cas), issues: string[] = [];
  if (!session.calendarVerified) issues.push('Exchange calendar unverified');
  if (!validQ) issues.push('Quote timestamp unavailable');
  if (!validC) issues.push('Candle timestamp unavailable');
  if (validC && validC.getTime() > now.getTime() + 60000) issues.push('Candle timestamp is in the future');
  const delay = delayMinutes != null && Number.isFinite(delayMinutes) && delayMinutes >= 0 ? delayMinutes : null;
  if (delay === null) issues.push('Provider delay unknown');
  const completed = latestCompletedSession(now, cas);
  const live = session.state === 'LIVE', requiredSession = live ? day : completed;
  if (session.state === 'UNKNOWN' && session.calendarVerified) issues.push('Closing session has not been verified complete');
  if (validQ && (validQ.getTime() > now.getTime() + 60000 || !requiredSession ||
      dateToISTString(validQ) !== requiredSession ||
      (live && (+validQ < +sessionTime(day, cashSessionLimits(day, cas).continuousStart) ||
        now.getTime() - validQ.getTime() > ((delay ?? 0) + 5) * 60000)))) {
    issues.push('Quote is stale or outside expected session');
  } else if (validQ && !live && completed &&
      validQ < sessionTime(completed, cashSessionLimits(completed, eligibility?.day === completed ? eligibility.casEligible : null).finalClose)) {
    issues.push('Quote predates the verified session close');
  }
  const requiredCandleSession = intraday ? requiredSession : completed;
  if (validC && requiredCandleSession && dateToISTString(validC) < requiredCandleSession) issues.push('Candles are from an older session');
  if (intraday && live && validC && now.getTime() - validC.getTime() > ((delay ?? 0) + 30) * 60000) issues.push('Intraday candles are stale');
  return { quoteAt: validQ?.toISOString() ?? null, candleAt: validC?.toISOString() ?? null, fetchedAt: now.toISOString(), delayMinutes: delay, stale: issues.length > 0, incompleteCandle: Boolean(live && validC && (intraday ? now.getTime() - validC.getTime() < 900000 : dateToISTString(validC) === day)), issues, ...(eligibility ? { sessionEligibility: eligibility } : {}) };
}
export function recheckDataQuality(data: DataQuality, intraday: boolean, now = new Date()):DataQuality {
  const current=assessDataQuality(data.quoteAt,data.candleAt,data.delayMinutes,intraday,now,data.sessionEligibility);
  return {...data,...current,fetchedAt:data.fetchedAt,stale:data.stale||current.stale,issues:[...new Set([...data.issues,...current.issues])]};
}

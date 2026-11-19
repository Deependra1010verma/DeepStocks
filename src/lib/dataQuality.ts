import { dateToISTString, getMarketSession, latestCompletedSession } from './timezone';
export interface DataQuality { quoteAt: string | null; candleAt: string | null; fetchedAt: string; delayMinutes: number | null; stale: boolean; incompleteCandle: boolean; issues: string[]; quoteSource?: 'Yahoo' | 'NSE EOD'; candleSource?: 'Yahoo' | 'NSE EOD'; restoredCashSessions?: string[] }
export function assessDataQuality(quoteAt: Date | string | null, candleAt: Date | string | null, delayMinutes: number | null, intraday: boolean, now = new Date()): DataQuality {
  const q = quoteAt ? new Date(quoteAt) : null, c = candleAt ? new Date(candleAt) : null;
  const validQ = q && Number.isFinite(q.getTime()) ? q : null, validC = c && Number.isFinite(c.getTime()) ? c : null;
  const session = getMarketSession(now), issues: string[] = [];
  if (!session.calendarVerified) issues.push('Exchange calendar unverified');
  if (!validQ) issues.push('Quote timestamp unavailable');
  if (!validC) issues.push('Candle timestamp unavailable');
  if (validC && validC.getTime() > now.getTime() + 60000) issues.push('Candle timestamp is in the future');
  const delay = delayMinutes != null && Number.isFinite(delayMinutes) && delayMinutes >= 0 ? delayMinutes : null;
  if (delay === null) issues.push('Provider delay unknown');
  const live = session.state === 'LIVE', requiredSession = live ? dateToISTString(now) : latestCompletedSession(now);
  if (validQ && (validQ.getTime() > now.getTime() + 60000 || (requiredSession && dateToISTString(validQ) < requiredSession) || (live && now.getTime() - validQ.getTime() > ((delay ?? 0) + 5) * 60000))) issues.push('Quote is stale or outside expected session');
  const requiredCandleSession = intraday ? requiredSession : latestCompletedSession(now);
  if (validC && requiredCandleSession && dateToISTString(validC) < requiredCandleSession) issues.push('Candles are from an older session');
  if (intraday && live && validC && now.getTime() - validC.getTime() > ((delay ?? 0) + 30) * 60000) issues.push('Intraday candles are stale');
  return { quoteAt: validQ?.toISOString() ?? null, candleAt: validC?.toISOString() ?? null, fetchedAt: now.toISOString(), delayMinutes: delay, stale: issues.length > 0, incompleteCandle: Boolean(live && validC && (intraday ? now.getTime() - validC.getTime() < 900000 : dateToISTString(validC) === dateToISTString(now))), issues };
}
export function recheckDataQuality(data: DataQuality, intraday: boolean, now = new Date()):DataQuality {
  const current=assessDataQuality(data.quoteAt,data.candleAt,data.delayMinutes,intraday,now);
  return {...data,...current,fetchedAt:data.fetchedAt,stale:data.stale||current.stale,issues:[...new Set([...data.issues,...current.issues])]};
}

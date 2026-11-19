import type { Position } from './portfolioEngine';
import { completedCloseTime, getCashSession, type ExchangeClose } from './nseSessionData';
import { getNseEvents, type NseCorporateEvent } from './nseCorporateEvents';
import { latestCompletedSession, tradingDaysAway } from './timezone';

export function exchangePositionReview(
  position: Position,
  session: string | null,
  close: ExchangeClose | undefined,
  events: NseCorporateEvent[],
  now = new Date()
) {
  const alerts: string[] = [];
  const price = close?.candle.close ?? null;
  if (session && price != null) {
    const closedAt = +completedCloseTime(session);
    const lastFillAt = Date.parse(position.lastFillAt);
    if (!Number.isFinite(lastFillAt)) {
      alerts.push('Last recorded fill time is unavailable.');
    } else if (lastFillAt > closedAt) {
      alerts.push('The exchange close predates the last recorded fill.');
    } else {
      const lastStopChange = position.stopHistory.at(-1)?.at;
      if (
        position.stop != null &&
        (!lastStopChange || Date.parse(lastStopChange) <= closedAt) &&
        price <= position.stop
      ) {
        alerts.push('NSE close at or below the recorded stop. Review with your broker.');
      }
      if (position.target2 != null && price >= position.target2) {
        alerts.push('NSE close at or above T2. Review the remaining position.');
      } else if (
        !position.firstTargetFilledAt &&
        position.target1 != null &&
        price >= position.target1
      ) {
        alerts.push('NSE close at or above T1. Review the planned partial exit.');
      }
    }
  }
  const upcoming = events.filter((event) => {
    const distance = tradingDaysAway(now, new Date(event.day + 'T12:00:00+05:30'));
    return distance != null && distance >= 0 && distance <= 5;
  });
  return { id: position.id, price, session, alerts, upcoming };
}

export type ExchangePositionReview = ReturnType<typeof exchangePositionReview>;

export async function reviewPortfolioExchange(
  positions: Position[],
  now = new Date()
): Promise<ExchangePositionReview[]> {
  if (!positions.length) return [];
  const session = latestCompletedSession(now);
  const [cash, events] = await Promise.all([getCashSession(session), getNseEvents()]);
  return positions.map((position) =>
    exchangePositionReview(
      position,
      session,
      cash.get(position.symbol),
      events.get(position.symbol) ?? [],
      now
    )
  );
}

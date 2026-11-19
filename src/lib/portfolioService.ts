import mongoose from 'mongoose';
import { connectDB } from './db';
import {
  applyPortfolioAction,
  emptyPortfolio,
  portfolioSessionOpening,
  type Portfolio,
  type PortfolioAction,
  type PortfolioPriorCloses
} from './portfolioEngine';
import { AppError } from './operations';
import { getCashSession } from './nseSessionData';
import { getNsePriceBasisActions } from './nseCorporateEvents';

export async function loadPortfolioPriorCloses(portfolio: Portfolio, now = new Date()): Promise<PortfolioPriorCloses | null> {
  const opening = portfolioSessionOpening(portfolio, now);
  if (!opening.carried?.length || !opening.priorSession) return null;
  const session = opening.priorSession;
  const [closes, actions] = await Promise.all([
    getCashSession(session),
    getNsePriceBasisActions(opening.session, opening.session)
  ]);
  const prices: Record<string, number> = {};
  if (!actions) return { session, prices, issue:'Corporate-action coverage unavailable for opening equity' };
  for (const [symbol] of opening.carried) {
    if (actions.has(symbol)) return { session, prices, issue:`Opening equity requires corporate-action reconciliation for ${symbol}` };
    const row = closes.get(symbol);
    if (row) prices[symbol] = row.candle.close;
  }
  return { session, prices };
}
export async function readPortfolio(): Promise<Portfolio> {
  await connectDB();
  return (
    (await mongoose.connection
      .db!.collection<Portfolio>('owner_portfolios')
      .findOne({ _id: 'owner' }, { maxTimeMS: 2000 })) ?? emptyPortfolio()
  );
}
export async function savePortfolioAction(
  action: PortfolioAction,
  expectedVersion: number
): Promise<Portfolio> {
  const original = await readPortfolio();
  let next: Portfolio;
  try {
    next = applyPortfolioAction(original, action);
  } catch (error) {
    throw new AppError(
      'INVALID_PORTFOLIO',
      error instanceof Error ? error.message : 'Invalid portfolio update',
      422
    );
  }
  if (next === original) return original;
  if (original.version !== expectedVersion)
    throw new AppError(
      'PORTFOLIO_CHANGED',
      'Portfolio changed in another tab. Reload before applying this update.',
      409
    );
  const col = mongoose.connection.db!.collection<Portfolio>('owner_portfolios');
  if (original.version === 0) {
    try {
      await col.insertOne(next);
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new AppError('PORTFOLIO_CHANGED', 'Portfolio changed. Reload before retrying.', 409);
      throw error;
    }
  } else {
    const result = await col.replaceOne({ _id: 'owner', version: expectedVersion }, next);
    if (!result.matchedCount)
      throw new AppError('PORTFOLIO_CHANGED', 'Portfolio changed. Reload before retrying.', 409);
  }
  return next;
}

import mongoose from 'mongoose';
import { connectDB } from './db';
import {
  applyPortfolioAction,
  emptyPortfolio,
  type Portfolio,
  type PortfolioAction
} from './portfolioEngine';
import { AppError } from './operations';
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

import { NextRequest, NextResponse } from 'next/server';
import { authorizeRequest, requireOwner, readBody, apiError } from '@/lib/apiSecurity';
import { loadPortfolioPriorCloses, readPortfolio, savePortfolioAction } from '@/lib/portfolioService';
import {
  portfolioSizing,
  portfolioTotals,
  positionReview,
  type PortfolioAction,
  type Portfolio,
  type PortfolioPriorCloses
} from '@/lib/portfolioEngine';
import { validMode, validSymbol, resolveStock } from '@/lib/stockService';
import { getTradePlan } from '@/lib/tradePlan';
import { enforceRiskGuards } from '@/lib/analysisRules';
import { AppError } from '@/lib/operations';
import { beforeDeadline } from '@/lib/deadline';
import { NSE_SCAN_UNIVERSE } from '@/lib/niftyStocks';
import { reviewPortfolioExchange } from '@/lib/portfolioExchangeReview';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function readDailyCloses(portfolio: Portfolio) {
  return beforeDeadline(() => loadPortfolioPriorCloses(portfolio), Date.now() + 5200).catch(() => null);
}
async function portfolioPayload(portfolio: Portfolio, checkedCloses?: PortfolioPriorCloses | null) {
  const dailyCloses = checkedCloses === undefined ? await readDailyCloses(portfolio) : checkedCloses;
  const now = new Date();
  return {
    portfolio,
    dailyCloses,
    totals: portfolioTotals(portfolio, now, dailyCloses),
    reviews: portfolio.positions.map(p => ({id:p.id, actions:positionReview(p, now)}))
  };
}

export async function GET(req: NextRequest) {
  try {
    requireOwner(req);
    const portfolio = await beforeDeadline(readPortfolio, Date.now() + 7000);
    if (req.nextUrl.searchParams.get('exchangeReview') === '1') {
      const exchangeReviews = await reviewPortfolioExchange(portfolio.positions);
      return NextResponse.json({ exchangeReviews }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(
      await portfolioPayload(portfolio),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return apiError(e);
  }
}
export async function POST(req: NextRequest) {
  try {
    await authorizeRequest(req, 'portfolio', 15);
    const body = await readBody(req);
    if (!Number.isInteger(body.version) || typeof body.action !== 'object' || !body.action)
      throw new AppError('INVALID_REQUEST', 'Version and portfolio action required.', 400);
    let action = body.action as PortfolioAction;
    let checkedCloses: PortfolioPriorCloses | null | undefined;
    if (action.type === 'fill') {
      const symbol = validSymbol(action.symbol),
        mode = validMode(action.mode);
      action = {
        ...action,
        symbol,
        mode,
        sector: NSE_SCAN_UNIVERSE.find((x) => x.symbol === symbol)?.sector ?? 'Unknown'
      };
    }
    if (action.type === 'reserve') {
      const input = body.action as Record<string, unknown>;
      const stock = await resolveStock(validSymbol(input.symbol), validMode(input.mode)),
        plan = getTradePlan(stock),
        portfolio = await readPortfolio();
      if (portfolio.version !== body.version) {
        throw new AppError('PORTFOLIO_CHANGED', 'Portfolio changed in another tab. Reload before applying this update.', 409);
      }
      checkedCloses = await readDailyCloses(portfolio);
      const sizing = portfolioSizing(
        portfolio,
        plan,
        stock.sector,
        stock.symbol,
        enforceRiskGuards({}, stock).verdictBadge === 'WATCHLIST ONLY'
          ? 0
          : (stock.positionRiskPercent ?? 0),
        new Date(),
        checkedCloses
      );
      const quantity = Number(input.quantity);
      if (!plan || !Number.isInteger(quantity) || quantity <= 0 || quantity > sizing.quantity)
        throw new AppError(
          'RISK_LIMIT',
          sizing.reasons.join('; ') || 'Quantity exceeds current portfolio limits.',
          422
        );
      const fraction = quantity / sizing.quantity;
      action = {
        id: action.id,
        type: 'reserve',
        reservation: {
          id: action.id,
          symbol: stock.symbol,
          sector: stock.sector,
          quantity,
          cash: sizing.cashRequired * fraction,
          risk: sizing.plannedRisk * fraction,
          createdAt: new Date().toISOString()
        }
      };
    }
    const portfolio = await beforeDeadline(
      () => savePortfolioAction(action, Number(body.version)),
      Date.now() + 10000
    );
    return NextResponse.json(
      await portfolioPayload(portfolio, checkedCloses),
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    return apiError(e);
  }
}

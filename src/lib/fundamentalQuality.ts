export interface AnnualFinancials {
  date: string;
  revenue: number | null;
  profit: number | null;
  operatingCashFlow: number | null;
  debt: number | null;
  equity: number | null;
  shares: number | null;
}

const DAY_MS = 86_400_000;
const FINANCIAL_SECTORS = new Set(['banking', 'nbfc', 'insurance', 'financial services']);

export function positiveNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

export function comparableAnnualPeriods(history: AnnualFinancials[] | undefined, now = new Date()) {
  const rows = [...(history ?? [])];
  if (rows.length < 3) return { issue: 'Three years of annual financial statements unavailable' };
  const dates = new Set<string>();
  for (const row of rows) {
    const stamp = Date.parse(row.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(stamp) || stamp > +now ||
        new Date(stamp).toISOString().slice(0, 10) !== row.date || dates.has(row.date)) {
      return { issue: 'Annual fiscal period dates are invalid, future-dated or duplicated' };
    }
    dates.add(row.date);
  }
  const years = rows.sort((a,b) => a.date.localeCompare(b.date)).slice(-3);
  const end = years[2].date;
  if (+now - Date.parse(end) > 550 * DAY_MS) return { issue: 'Annual financial statements are stale' };
  if (years.some(({date}, index) => Number(date.slice(0, 4)) !== Number(end.slice(0, 4)) - (2 - index) ||
      date.slice(5) !== end.slice(5))) {
    return { issue: 'Three consecutive, comparable annual fiscal periods unavailable' };
  }
  return { years };
}

export function evaluateFundamentalQuality(history: AnnualFinancials[] | undefined, sector: string, now = new Date()): string[] {
  const {years, issue} = comparableAnnualPeriods(history, now);
  if (!years) return [issue];
  const reasons: string[] = [], latest = years[2], first = years[0];
  if (years.some(y => !positiveNumber(y.profit) || !positiveNumber(y.revenue))) reasons.push('Three-year revenue/profit quality unverified or negative');
  if (positiveNumber(latest.revenue) && positiveNumber(first.revenue) && latest.revenue <= first.revenue) reasons.push('Revenue has not grown across the reviewed years');
  if (!positiveNumber(latest.shares) || !positiveNumber(first.shares)) reasons.push('Share dilution history unavailable');
  else if (latest.shares > first.shares * 1.15) reasons.push('Share count increased more than 15% across the reviewed years');
  const normalizedSector = sector.trim().toLowerCase();
  if (FINANCIAL_SECTORS.has(normalizedSector) || /bank|finance|financial|insurance/i.test(normalizedSector)) {
    reasons.push('Financial-sector capital adequacy, asset quality and valuation review required');
  } else {
    if (years.some(y => !positiveNumber(y.operatingCashFlow))) reasons.push('Positive operating cash flow not verified for all three years');
    if (latest.debt === null || !Number.isFinite(latest.debt) || latest.debt < 0 ||
        !positiveNumber(latest.equity) || latest.debt / latest.equity > 1) reasons.push('Latest debt/equity is unavailable or above 1');
  }
  return reasons;
}

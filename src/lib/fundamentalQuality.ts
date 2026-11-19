export interface AnnualFinancials { date: string; revenue: number | null; profit: number | null; operatingCashFlow: number | null; debt: number | null; equity: number | null; shares: number | null }
export function evaluateFundamentalQuality(history: AnnualFinancials[] | undefined, sector: string, now = new Date()): string[] {
  const years = [...(history ?? [])].filter(y => Number.isFinite(Date.parse(y.date)) && Date.parse(y.date) <= +now).sort((a,b) => Date.parse(a.date)-Date.parse(b.date)).slice(-3);
  if (years.length < 3 || new Set(years.map(y=>y.date.slice(0,4))).size < 3) return ['Three years of annual financial statements unavailable'];
  const reasons: string[] = [], latest = years[2], first = years[0];
  if (+now - Date.parse(latest.date) > 550 * 86400000) reasons.push('Annual financial statements are stale');
  if (years.some(y => y.profit == null || y.profit <= 0 || y.revenue == null || y.revenue <= 0)) reasons.push('Three-year revenue/profit quality unverified or negative');
  if (latest.revenue != null && first.revenue != null && latest.revenue <= first.revenue) reasons.push('Revenue has not grown across the reviewed years');
  if (latest.shares == null || first.shares == null) reasons.push('Share dilution history unavailable');
  else if (latest.shares > first.shares * 1.15) reasons.push('Share count increased more than 15% across the reviewed years');
  if (/bank|finance|financial|insurance/i.test(sector)) {
    reasons.push('Financial-sector capital adequacy, asset quality and valuation review required');
  } else {
    if (years.some(y => y.operatingCashFlow == null || y.operatingCashFlow <= 0)) reasons.push('Positive operating cash flow not verified for all three years');
    if (latest.debt == null || latest.equity == null || latest.equity <= 0 || latest.debt / latest.equity > 1) reasons.push('Latest debt/equity is unavailable or above 1');
  }
  return reasons;
}

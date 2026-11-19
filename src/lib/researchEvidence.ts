import type { ScreenedStock } from './screenerEngine';
import type { NewsItem } from './dataFetcher';
import { getTradePlan } from './tradePlan';
import { RVOL_SESSIONS } from './relativeVolume';
export const EVIDENCE_VERSION = 'evidence-2026-11-v1';
export interface ResearchFact {
  id: string;
  section: 'technical' | 'fundamental' | 'news' | 'risk';
  text: string;
  source: string;
  asOf: string | null;
  status: 'reported' | 'calculated' | 'unknown' | 'unverified-headline';
}
export function buildResearchEvidence(stock: ScreenedStock, news: NewsItem[] = []): ResearchFact[] {
  const at = stock.dataQuality?.quoteAt ?? null,
    interval = stock.mode === 'intraday' ? '15-minute bars' : 'daily bars';
  const source = `https://finance.yahoo.com/quote/${encodeURIComponent(stock.symbol)}/`;
  const exchange = 'https://www.nseindia.com/all-reports';
  const officialQuote = stock.dataQuality?.quoteSource === 'NSE EOD';
  const officialCandle = stock.dataQuality?.candleSource === 'NSE EOD';
  const facts: ResearchFact[] = [];
  const add = (
    id: string,
    section: ResearchFact['section'],
    text: string,
    status: ResearchFact['status'] = 'calculated',
    asOf = at,
    url = source
  ) => facts.push({ id, section, text, status, asOf, source: url });
  add(
    'price',
    'technical',
    officialQuote
      ? `Official NSE session close ₹${stock.cmp.toFixed(2)}. Historical end-of-day price.`
      : `Reported CMP ₹${stock.cmp.toFixed(2)}; provider delay ${stock.dataQuality?.delayMinutes ?? 'unknown'} minutes.`,
    'reported',
    at,
    officialQuote ? exchange : source
  );
  add(
    'ema',
    'technical',
    `EMA20 ₹${stock.ema20.toFixed(2)}, EMA50 ₹${stock.ema50.toFixed(2)}, EMA200 ${stock.ema200 == null ? 'unavailable' : `₹${stock.ema200.toFixed(2)}`}; periods are counts of ${interval}.`
  );
  const relativeVolume = stock.relativeVolume;
  add(
    'rvol',
    'technical',
    relativeVolume
      ? `Relative volume ${relativeVolume.value.toFixed(2)}× on ${relativeVolume.session}: ${relativeVolume.volume} shares divided by ${relativeVolume.averageVolume} average shares over ${RVOL_SESSIONS} prior sessions. ${relativeVolume.kind === 'intraday-cumulative' ? 'Cumulative through the same completed 15-minute time slot.' : relativeVolume.kind === 'daily-so-far' ? 'Current session volume so far compared with completed daily totals.' : 'Completed daily volume compared with completed daily totals.'}`
      : relativeVolume === null ? `Relative volume unavailable. The calculation needs ${RVOL_SESSIONS} comparable prior sessions and current volume.`
        : `Relative volume ${stock.rvol.toFixed(2)}× from a saved result with unavailable baseline details.`,
    relativeVolume ? 'calculated' : 'unknown',
    relativeVolume?.through ?? at
  );
  add(
    'rsi',
    'technical',
    `RSI14 ${stock.rsi.toFixed(2)} on ${interval}; this is not a probability of profit.`
  );
  add(
    'qualification',
    'risk',
    stock.researchQualified
      ? 'Passed the quant research shortlist. Verify filings and valuation before making an investment decision.'
      : stock.nearMiss
        ? 'Near miss: one or more qualification conditions failed; this does not mean price is close to the stop.'
        : 'Quant conditions passed the available checks; execution and portfolio clearance are separate.'
  );
  if (officialCandle)
    add(
      'exchange-candle',
      'technical',
      'Latest completed daily OHLC and volume came from the official NSE session report.',
      'reported',
      stock.dataQuality?.candleAt ?? null,
      exchange
    );
  if (stock.sectorBenchmark) {
    const benchmark=stock.sectorBenchmark;
    add('sector-benchmark','technical',
      `${benchmark.index} returned ${benchmark.sectorReturn.toFixed(2)}% vs ${benchmark.niftyReturn.toFixed(2)}% for Nifty 50 across 20 regular sessions from ${benchmark.from} to ${benchmark.asOf}. Relative change ${benchmark.relativeChange.toFixed(2)} percentage points adds ${benchmark.scoreBoost} score points.`,
      'calculated',benchmark.asOf,'https://www.niftyindices.com/reports/daily-reports');
  }
  const f = stock.fundamentals;
  for (const [id, label, value, unit] of [
    ['roe', 'ROE', f.returnOnEquity, 'fraction'],
    ['revenue', 'Revenue growth', f.revenueGrowth, 'fraction'],
    ['earnings', 'Earnings growth', f.earningsGrowth, 'fraction'],
    ['debt', 'Debt/equity', f.debtToEquity, 'percent-ratio'],
    ['pe', 'Forward P/E', f.forwardPE, 'multiple'],
    ['cap', 'Market capitalization', f.marketCap, 'INR']
  ] as const) {
    const text =
      value == null || !Number.isFinite(value)
        ? `${label}: unavailable.`
        : `${label}: ${unit === 'fraction' ? `${(value * 100).toFixed(2)}%` : unit === 'percent-ratio' ? `${value.toFixed(2)}% (ratio ${(value / 100).toFixed(2)}×)` : unit === 'INR' ? `₹${value.toFixed(0)}` : `${value.toFixed(2)}×`}. Provider reporting period is unspecified; no peer/sector ranking or multi-year growth is inferred.`;
    add(id, 'fundamental', text, value == null ? 'unknown' : 'reported', f.asOf ?? null);
  }
  const years = [...(f.annualHistory ?? [])]
    .filter((y) => Number.isFinite(Date.parse(y.date)) && Date.parse(y.date) <= Date.now())
    .sort((a, b) => a.date.localeCompare(b.date));
  if (years.length) {
    const y = years.at(-1)!;
    const conversion =
      y.profit && y.profit > 0 && y.operatingCashFlow != null ? y.operatingCashFlow / y.profit : null;
    add(
      'cash-conversion',
      'fundamental',
      `Annual period ended ${y.date}: operating cash flow / profit ${conversion == null ? 'unavailable' : conversion.toFixed(2) + '×'}. Filing publication date is unavailable; do not use this as point-in-time backtest evidence.`,
      'reported',
      f.asOf ?? null
    );
    const first = years[0];
    if (first !== y && first.shares != null && first.shares > 0 && y.shares != null)
      add(
        'dilution',
        'fundamental',
        `Share count changed ${((y.shares / first.shares - 1) * 100).toFixed(2)}% between fiscal periods ended ${first.date} and ${y.date}. Review splits and issuance before attributing the change to dilution.`,
        'calculated',
        f.asOf ?? null
      );
  }
  add(
    'filings',
    'fundamental',
    'Review primary quarterly releases, annual reports and exchange disclosures before relying on provider fundamentals. Sector peers and intrinsic valuation are unavailable.',
    'unknown',
    null,
    `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(stock.symbol.replace(/\.NS$/, ''))}`
  );
  add(
    'event',
    'risk',
    `Calendar provider reports earnings date ${stock.earningsDate ?? f.earningsDate ?? 'unavailable'}. Calendar coverage: ${stock.eventStatus ?? 'unknown'}. Headline publication dates are not event dates; conflicting reports require exchange-filing verification.`,
    'reported'
  );
  for (const [index,event] of (stock.exchangeEvents??[]).slice(0,4).entries()) {
    add(`nse-event-${index}`,'risk',`NSE lists ${event.label.toLowerCase()} for ${event.day}.`,'reported',event.publishedAt??null,event.source);
  }
  for (const [index, entry] of (stock.surveillance??[]).slice(0,3).entries()) {
    add(`nse-surveillance-${index}`,'risk',`NSE lists surveillance flag ${entry.code} for ISIN ${entry.isin}.`,'reported',entry.asOf,entry.source);
  }
  if (stock.exchangePriceBand) {
    const band=stock.exchangePriceBand;
    add('nse-price-band','risk',
      band.percent==null?'NSE lists no fixed daily price band. Dynamic controls may apply.':`NSE published a fixed daily price band of ${band.percent}%.`,
      'reported',band.publishedDay,'https://nsearchives.nseindia.com/content/equities/sec_list.csv');
  }
  const p = getTradePlan(stock);
  if (p)
    add(
      'plan',
      'risk',
      `At entry-zone high ₹${p.entryHigh.toFixed(2)}, gross T1 reward/risk ${p.riskRewardRatio.toFixed(2)}; estimated net ${p.netRiskReward.toFixed(2)} after ${p.estimatedCostBps} bps costs and ${p.estimatedSlippageBps} bps each-side slippage. Policy minimum ${p.minimumNetRR.toFixed(2)}; assumptions are not broker fills.`
    );
  for (const [i, reason] of [...new Set(stock.guardReasons ?? [])].entries())
    add(`guard-${i}`, 'risk', reason);
  for (const [i, item] of news
    .filter(
      (n) =>
        /^https:\/\//.test(n.link) &&
        Number.isFinite(Date.parse(n.pubDate)) &&
        Date.parse(n.pubDate) <= Date.now()
    )
    .slice(0, 3)
    .entries())
    add(
      `news-${i}`,
      'news',
      `Unverified headline published ${new Date(item.pubDate).toISOString()}: ${item.title.slice(0, 240)}. Verify the linked report; headline content has not been corroborated.`,
      'unverified-headline',
      item.pubDate,
      item.link
    );
  if (!facts.some((x) => x.section === 'news'))
    add('no-news', 'news', 'No dated news evidence supplied.', 'unknown');
  return facts;
}
export const EVIDENCE_SELECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    ['technical', 'fundamental', 'news', 'risk'].map((key) => [
      key,
      { type: 'array', items: { type: 'string' }, maxItems: 3 }
    ])
  ),
  required: ['technical', 'fundamental', 'news', 'risk']
};
export function validateEvidenceSelection(
  value: unknown,
  facts: ResearchFact[]
): Record<ResearchFact['section'], string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Evidence selection failed validation.');
  const result = {} as Record<ResearchFact['section'], string[]>;
  if (Object.keys(value).some((k) => !['technical', 'fundamental', 'news', 'risk'].includes(k)))
    throw new Error('Unsupported narrative fields rejected.');
  for (const section of ['technical', 'fundamental', 'news', 'risk'] as const) {
    const ids = (value as Record<string, unknown>)[section];
    if (
      !Array.isArray(ids) ||
      ids.length > 3 ||
      ids.some(
        (id) => typeof id !== 'string' || !facts.some((f) => f.id === id && f.section === section)
      )
    )
      throw new Error('Unsupported evidence reference rejected.');
    result[section] = [...new Set(ids)];
  }
  return result;
}

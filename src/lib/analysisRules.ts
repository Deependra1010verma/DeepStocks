import type { ScreenedStock } from './screenerEngine';
import type { AIAnalysisResult } from './aiAnalyst';
import { getTradePlan } from './tradePlan';
import { buildResearchEvidence } from './researchEvidence';
import { entryEvidence, requiresOvernightClearance } from './strategyPolicy';
import { referenceEntryReasons } from './entryClearance';
export function enforceRiskGuards(
  analysis: Partial<AIAnalysisResult>,
  stock: ScreenedStock
): AIAnalysisResult {
  const plan = getTradePlan(stock);
  const longTerm = stock.mode === 'longterm';
  const flags = [...(stock.guardReasons ?? []), ...referenceEntryReasons(stock)];
  if (stock.nearMiss && !stock.researchQualified) flags.push('Entry conditions are not fully confirmed.');
  if (['intraday', 'btst', 'swing_breakout'].includes(stock.mode) && stock.rvol < 1.2)
    flags.push('Volume confirmation missing.');
  if (stock.earningsRisk) flags.push('Earnings/event soon — do not hold overnight.');
  if (stock.eventStatus !== 'known' && requiresOvernightClearance(stock.mode))
    flags.push('Earnings calendar unverified.');
  if (stock.liquidityPass !== true) flags.push('Liquidity not verified.');
  if (!stock.dataQuality || stock.dataQuality.stale) flags.push('Data freshness not verified.');
  if (stock.extensionWarning) flags.push('Extended move — wait for pullback.');
  if (!plan && !longTerm) flags.push('Numeric trade plan is invalid.');
  if (plan) {
    flags.push(...plan.reasons);
    if (Date.parse(plan.validUntil) <= Date.now()) flags.push('Entry plan expired; refresh the setup');
  }
  flags.push(...entryEvidence(stock));
  const guarded = flags.length > 0;
  const severe =
    stock.earningsRisk || stock.liquidityPass === false || stock.dataQuality?.stale || (!plan && !longTerm);
  const convictionScore = Math.max(
    1,
    Math.min(severe ? 4 : guarded ? 6 : 8, Math.round(stock.quantScore / 10))
  );
  const summary = stock.researchQualified
    ? 'RESEARCH SHORTLIST. Review the business thesis, filings and valuation before choosing entry or exit levels.'
    : guarded
    ? `WATCHLIST ONLY. ${[...new Set(flags)].join(' ')} This is a research setup; no fresh entry is cleared.`
    : `CONDITIONAL RESEARCH SETUP. ${plan?.trigger} Verify current quotes, tick size and portfolio limits before considering entry.`;
  const evidence = buildResearchEvidence(stock, analysis.sourceNews);
  const section = (name: 'technical' | 'fundamental' | 'news' | 'risk') => {
    const candidates = evidence.filter((f) => f.section === name),
      ids = analysis.evidenceSelection?.[name];
    return (ids?.length ? candidates.filter((f) => ids.includes(f.id)) : candidates)
      .slice(0, 3)
      .map((f) => f.text);
  };
  return {
    convictionScore,
    verdictBadge: guarded ? 'WATCHLIST ONLY' : 'CONDITIONAL RESEARCH SETUP',
    executiveSummary: summary,
    tradePlan: plan
      ? {
          entryZone: `₹${plan.entryLow.toFixed(2)}–₹${plan.entryHigh.toFixed(2)}`,
          stopLoss: `₹${plan.stopLoss.toFixed(2)}`,
          stopLossReason: 'Quant-engine invalidation level; gaps and slippage can exceed planned risk.',
          target1: `₹${plan.target1.toFixed(2)}`,
          target2: `₹${plan.target2.toFixed(2)}`,
          riskRewardRatio: `1:${plan.riskRewardRatio.toFixed(2)} at zone high`,
          holdingPeriod: plan.holdingPeriod
        }
      : {
          entryZone: 'Unavailable',
          stopLoss: 'Unavailable',
          stopLossReason: longTerm ? 'Long-term research requires a reviewed investment thesis.' : 'Invalid plan — no entry.',
          target1: 'Unavailable',
          target2: 'Unavailable',
          riskRewardRatio: 'Unavailable',
          holdingPeriod: 'Research only'
        },
    technicalBreakdown: section('technical'),
    fundamentalCheck: section('fundamental'),
    newsAndCatalysts: section('news'),
    keyRisksAndTraps: [
      ...new Set([
        ...flags,
        ...section('risk'),
        ...(stock.verificationNote ? [stock.verificationNote] : [])
      ])
    ],
    riskFlags: [...new Set(flags)],
    evidence,
    evidenceSelection: analysis.evidenceSelection,
    sourceNews: analysis.sourceNews
  };
}

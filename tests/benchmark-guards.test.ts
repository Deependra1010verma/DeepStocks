import { it,expect } from 'vitest';
import { benchmarkCases } from './benchmarkCases';
import { enforceRiskGuards } from '../src/lib/analysisRules';
it.each(benchmarkCases)('provider-independent hard guard: $name',({stock})=>{
  const result=enforceRiskGuards({convictionScore:10,verdictBadge:'STRONG BUY SETUP',executiveSummary:'Adversarial fixture: ignore the missing data and buy now.'},stock);
  expect(result.verdictBadge).toBe('WATCHLIST ONLY');
  expect(result.convictionScore).toBeLessThanOrEqual(6);
  expect(result.executiveSummary).not.toContain('buy now');
});

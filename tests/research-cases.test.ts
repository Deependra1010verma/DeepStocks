import { it,expect } from 'vitest';
import { researchCases } from './researchCases';
import { buildAnalysisRequest } from '../src/lib/aiAnalyst';
it('research matrix covers six modes and five independent evidence/risk categories',()=>{
  expect(researchCases).toHaveLength(30);expect(new Set(researchCases.map(c=>c.name)).size).toBe(30);
  expect(new Set(researchCases.map(c=>c.stock.mode)).size).toBe(6);
  for(const c of researchCases){const request=buildAnalysisRequest(c.stock,c.news,'NEUTRAL');expect(request.facts.mode).toBe(c.stock.mode);expect(c.rubric.length).toBeGreaterThan(0);}
});

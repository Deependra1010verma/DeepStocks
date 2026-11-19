import { it,expect,vi,beforeEach } from 'vitest';
const resolved=vi.hoisted(()=>({resolve:vi.fn(),generate:vi.fn(),budget:vi.fn()}));
vi.mock('../src/lib/stockService',async original=>({...await original<object>(),resolveStock:resolved.resolve}));
vi.mock('../src/lib/analysisService',async original=>({...await original<object>(),generateAndCache:resolved.generate}));
vi.mock('../src/lib/operations',async original=>({...await original<object>(),consumeBudget:resolved.budget}));
import { cachedAnalysisValid } from '../src/lib/analysisService';
import { ANALYSIS_VERSION,guardFingerprint } from '../src/lib/aiCachePolicy';
import { POST } from '../src/app/api/analyze/route';
import { POST as signIn } from '../src/app/api/session/route';
import { createSession } from '../src/lib/apiSecurity';
import { NextRequest } from 'next/server';
import { stock,NOW } from './fixtures';
beforeEach(()=>{vi.stubEnv('AI_PROVIDER','groq');vi.stubEnv('GROQ_API_KEY','synthetic-key');vi.stubEnv('GROQ_MODEL','openai/gpt-oss-120b');vi.stubEnv('APP_ACCESS_PASSWORD','test-password-long-enough');vi.stubEnv('SESSION_SECRET','test-signing-secret-long-enough-for-hmac');resolved.resolve.mockClear();resolved.generate.mockClear();});
const cache=()=>({version:ANALYSIS_VERSION,fingerprint:guardFingerprint(stock()),provider:'groq',modelId:'openai/gpt-oss-120b',expiresAt:new Date(+NOW+3600000),generatedAt:NOW,cachedCmp:1000});
it('expired cache is rejected even after market close',()=>expect(cachedAnalysisValid(cache(),stock(),+new Date('2026-11-18T17:00:00+05:30'))).toBe(false));
it('current guards and provider version invalidate old shared reports',()=>{expect(cachedAnalysisValid(cache(),stock(),+NOW)).toBe(true);expect(cachedAnalysisValid(cache(),stock({earningsRisk:true}),+NOW)).toBe(false);expect(cachedAnalysisValid({...cache(),modelId:'old-model'},stock(),+NOW)).toBe(false);});
it('client cannot inject price, conviction or regime into shared analysis',async()=>{const canonical=stock();resolved.resolve.mockResolvedValue(canonical);resolved.generate.mockResolvedValue({stock:canonical,analysis:{executiveSummary:'server computed'}});const req=new NextRequest('https://local.test/api/analyze',{method:'POST',headers:{origin:'https://local.test',cookie:`deepstocks_session=${createSession()}`},body:JSON.stringify({symbol:'alpha',mode:'swing_breakout',stock:{cmp:-10,quantScore:100},marketRegime:'BULLISH'})});const result=await POST(req);expect(result.status).toBe(200);expect(resolved.resolve).toHaveBeenCalledWith('ALPHA.NS','swing_breakout');expect(resolved.generate).toHaveBeenCalledWith(canonical,false);});
it('invalid mode is rejected before market-data or AI work',async()=>{const result=await POST(new NextRequest('https://local.test/api/analyze',{method:'POST',headers:{origin:'https://local.test',cookie:`deepstocks_session=${createSession()}`},body:JSON.stringify({symbol:'ALPHA',mode:'made-up'})}));expect(result.status).toBe(400);expect(resolved.resolve).not.toHaveBeenCalled();});
it('returns the refreshed stock and freshness reason without attempting AI for a stale candle',async()=>{
  const current=stock();
  const dataQuality={...current.dataQuality!,stale:true,issues:['Candles are from an older session']};
  resolved.resolve.mockResolvedValue(stock({dataQuality}));
  const result=await POST(new NextRequest('https://local.test/api/analyze',{
    method:'POST',headers:{origin:'https://local.test',cookie:`deepstocks_session=${createSession()}`},
    body:JSON.stringify({symbol:'ALPHA',mode:'swing_breakout'})
  }));
  expect(result.status).toBe(422);
  const body=await result.json();
  expect(body).toMatchObject({code:'STALE_DATA',stock:{symbol:'ALPHA.NS',dataQuality}});
  expect(body.error).toContain('Candles are from an older session');
  expect(resolved.generate).not.toHaveBeenCalled();
});
it('unauthenticated analysis never calls the provider',async()=>{const result=await POST(new NextRequest('https://local.test/api/analyze',{method:'POST',body:'{}'}));expect(result.status).toBe(401);expect(resolved.generate).not.toHaveBeenCalled();});
it('password sign-in creates a secure HttpOnly cookie without returning the password',async()=>{const req=new NextRequest('https://local.test/api/session',{method:'POST',headers:{origin:'https://local.test'},body:JSON.stringify({password:'test-password-long-enough'})});const response=await signIn(req);expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);expect(response.headers.get('set-cookie')).toMatch(/Secure/i);expect(await response.text()).not.toContain('test-password-long-enough');});
it('incorrect password never issues a session cookie',async()=>{const response=await signIn(new NextRequest('https://local.test/api/session',{method:'POST',headers:{origin:'https://local.test'},body:JSON.stringify({password:'wrong'})}));expect(response.status).toBe(401);expect(response.headers.get('set-cookie')).toBeNull();});

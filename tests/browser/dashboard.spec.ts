import { test,expect,type Page } from '@playwright/test';
import { stock,NOW } from '../fixtures';
import type { ScreenerMode } from '../../src/lib/screenerEngine';
import { guardFingerprint } from '../../src/lib/aiCachePolicy';
import { emptyPortfolio, applyPortfolioAction, portfolioTotals, positionReview, type PortfolioAction } from '../../src/lib/portfolioEngine';
type Controls={scanDelay?:Promise<void>;searchDelay?:Promise<void>;failAnalysis?:boolean;anonymous?:boolean;compact?:boolean};
async function setup(page:Page,controls:Controls={}) {
  await page.clock.install({time:NOW});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{(window as unknown as {copied:string}).copied=text;}}}));
  const calls:Array<{path:string;method:string;mode:string;body:Record<string,unknown>}>=[],errors:string[]=[];
  let portfolio=emptyPortfolio();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():{},mode=(body.mode??url.searchParams.get('mode')??'swing_breakout') as ScreenerMode;
    calls.push({path:url.pathname,method:req.method(),mode,body});
    let payload:unknown={},status=200;
    if(url.pathname==='/api/session') payload={authenticated:!controls.anonymous,configured:true,ai:{version:'fixture:model',configured:false}};
    if(url.pathname==='/api/scan'){
      if(mode==='btst'&&controls.scanDelay)await controls.scanDelay;
      const symbols=mode==='btst'?['BETA']:mode==='swing_pullback'?['GAMMA']:['ALPHA','DELTA'];
      const cards=symbols.map(name=>stock({symbol:`${name}.NS`,name:`${name} test fixture`,mode}));
      payload={stocks:controls.compact?cards.map(card=>({...card,candles:[]})):cards,generatedAt:NOW.toISOString(),expiresAt:new Date(+NOW+3600000).toISOString(),cached:true,stale:false,removedToday:[],coverage:{requested:261,processed:259,failed:['MISSING1.NS','MISSING2.NS']}};
    }
    if(url.pathname==='/api/market-mood')payload={regime:'NEUTRAL',available:true,niftyClose:'25000',ema20:'24900',ema50:'24800',session:{state:'LIVE',label:'MARKET OPEN',message:'Fixture session',timeIST:'10:35 IST'}};
    if(url.pathname==='/api/sector-strength')payload={topSectors:[]};
    if(url.pathname==='/api/portfolio'){
      if(req.method()==='POST')portfolio=applyPortfolioAction(portfolio,body.action as PortfolioAction,NOW);
      payload={portfolio,totals:portfolioTotals(portfolio,NOW),reviews:portfolio.positions.map(p=>({id:p.id,actions:positionReview(p,NOW)}))};
    }
    if(url.pathname==='/api/ledger')payload={stats:{closed:0,wins:0,winRate:null}};
    if(url.pathname==='/api/stock'){
      if(controls.searchDelay)await controls.searchDelay;
      const symbol=controls.compact?String(body.symbol):'SEARCH.NS';
      payload={stock:stock({symbol,name:`${symbol.replace('.NS','')} fixture`,mode})};
    }
    if(url.pathname==='/api/analyze'){
      if(controls.failAnalysis){status=503;payload={error:'Provider credits unavailable; quant research remains available.'};}
      else {const s=stock({symbol:body.symbol as string,name:`${String(body.symbol).replace('.NS','')} test fixture`,mode});payload={stock:s,analysis:{executiveSummary:`Fixture report for ${s.symbol}`,technicalBreakdown:['Controlled fixture'],fundamentalCheck:[],newsAndCatalysts:[],keyRisksAndTraps:[],tradePlan:{stopLoss:'₹1.00'}},cachedAt:NOW.toISOString(),expiresAt:new Date(+NOW+3600000).toISOString(),cachedCmp:s.cmp,fingerprint:guardFingerprint(s),cached:false};}
    }
    await route.fulfill({status,json:payload});
  });
  await page.goto('/');return {calls,errors};
}
const choose=(page:Page,name:string)=>page.getByRole('button').filter({hasText:`${name} test fixture`}).click();
test('private bootstrap does not request stocks before authentication',async({page})=>{const {calls}=await setup(page,{anonymous:true});await expect(page.getByLabel('Password')).toBeVisible();expect(calls.some(c=>c.path==='/api/scan')).toBe(false);});
test('desktop report, chart and canonical copied quantity',async({page})=>{const {calls,errors}=await setup(page);await choose(page,'ALPHA');await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();await expect(page.locator('canvas').first()).toBeVisible();await page.getByRole('textbox',{name:'Trading capital'}).fill('900000');await page.getByRole('button',{name:'Copy Setup',exact:true}).click();const copied=await page.evaluate(()=>(window as unknown as {copied:string}).copied);expect(copied).toContain('SL: ₹970.00');expect(copied).toContain('Qty: 0');expect(calls.filter(c=>c.path==='/api/ledger'&&c.method==='POST')).toHaveLength(0);expect(errors).toEqual([]);await page.clock.runFor(450);await page.screenshot({path:'test-results/desktop.png',animations:'disabled'});});
test('keyboard navigation reuses the cached report and preserves analyzed CMP',async({page})=>{const {calls}=await setup(page);await choose(page,'ALPHA');await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();await page.keyboard.press('/');await expect(page.getByRole('textbox',{name:'Search NSE symbol'})).toBeFocused();await page.getByRole('textbox',{name:'Search NSE symbol'}).evaluate(e=>(e as HTMLInputElement).blur());await page.keyboard.press('ArrowDown');await expect(page.getByRole('heading',{name:'DELTA',exact:true})).toBeVisible();const count=calls.filter(c=>c.path==='/api/analyze').length;await page.keyboard.press('ArrowUp');await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();expect(calls.filter(c=>c.path==='/api/analyze')).toHaveLength(count);});
test('late BTST response cannot overwrite selected Swing PB list or report',async({page})=>{let release!:()=>void;const scanDelay=new Promise<void>(r=>release=r);const {calls}=await setup(page,{scanDelay});await choose(page,'ALPHA');await page.getByRole('button',{name:'BTST',exact:true}).click();await expect.poll(()=>calls.some(c=>c.path==='/api/scan'&&c.mode==='btst')).toBe(true);await page.getByRole('button',{name:'Swing PB',exact:true}).click();await expect(page.getByRole('button').filter({hasText:'GAMMA test fixture'})).toBeVisible();const late=page.waitForResponse(r=>r.url().includes('/api/scan?')&&r.url().includes('btst'));release();await late;await expect(page.getByRole('button').filter({hasText:'BETA test fixture'})).toHaveCount(0);await expect(page.getByRole('heading',{name:'ALPHA',exact:true})).toHaveCount(0);});
test('a search response from the previous strategy is discarded',async({page})=>{let release!:()=>void;const searchDelay=new Promise<void>(r=>release=r);const {calls}=await setup(page,{searchDelay});await page.getByRole('textbox',{name:'Search NSE symbol'}).fill('SEARCH');await page.getByRole('textbox',{name:'Search NSE symbol'}).press('Enter');await expect.poll(()=>calls.some(c=>c.path==='/api/stock')).toBe(true);await page.getByRole('button',{name:'Swing PB',exact:true}).click();await expect(page.getByRole('button').filter({hasText:'GAMMA test fixture'})).toBeVisible();const late=page.waitForResponse(r=>r.url().includes('/api/stock'));release();await late;await expect(page.getByText('SEARCH fixture')).toHaveCount(0);});
test('390px viewport offers full-width list/detail without horizontal overflow',async({page})=>{await page.setViewportSize({width:390,height:844});await setup(page);await choose(page,'ALPHA');await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);expect((await page.getByRole('heading',{name:'ALPHA',exact:true}).boundingBox())?.x).toBeLessThan(100);await page.getByRole('textbox',{name:'Trading capital'}).scrollIntoViewIfNeeded();await page.clock.runFor(450);await page.screenshot({path:'test-results/mobile.png',animations:'disabled'});await page.getByRole('button',{name:'Results',exact:true}).click();await expect(page.getByRole('button').filter({hasText:'DELTA test fixture'})).toBeVisible();});
test('provider failure shows quant plan and actionable error without an automatic retry loop',async({page})=>{const {calls}=await setup(page,{failAnalysis:true});await choose(page,'ALPHA');await expect(page.getByText('Provider credits unavailable; quant research remains available.')).toBeVisible();await expect(page.getByRole('button',{name:'Copy Setup',exact:true})).toBeVisible();await page.clock.fastForward(10000);expect(calls.filter(c=>c.path==='/api/analyze')).toHaveLength(1);});
test('a compact snapshot loads chart candles even when the AI provider fails',async({page})=>{
  const {calls,errors}=await setup(page,{compact:true,failAnalysis:true});
  expect(calls.some(call=>call.path==='/api/stock')).toBe(false);
  await choose(page,'ALPHA');
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('Provider credits unavailable; quant research remains available.')).toBeVisible();
  const detailCalls=calls.filter(call=>call.path==='/api/stock'||call.path==='/api/analyze');
  expect(detailCalls.map(call=>[call.path,call.body.symbol])).toEqual([['/api/stock','ALPHA.NS'],['/api/analyze','ALPHA.NS']]);
  expect(errors).toEqual([]);
});
test('open dashboard polls snapshots and shows partial coverage',async({page})=>{const {calls}=await setup(page);await expect(page.getByText(/Coverage 259\/261/)).toBeVisible();const count=calls.filter(c=>c.path==='/api/scan').length;await page.clock.fastForward(61000);await expect.poll(()=>calls.filter(c=>c.path==='/api/scan').length).toBeGreaterThan(count);});

test('a stalled refresh preserves results and polling, and cannot lock a different tab', async ({ page }) => {
  const { calls, errors } = await setup(page);
  await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/scan', async route => { await pending; await route.fulfill({ json: { stocks: [] } }); });
  try {
    await page.getByRole('button', { name: 'Scan Swing BO', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scanning...', exact: true })).toBeDisabled();
    const count = calls.filter(c => c.path === '/api/scan').length;
    await page.clock.fastForward(16000);
    await expect.poll(() => calls.filter(c => c.path === '/api/scan').length).toBeGreaterThan(count);
    await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Swing PB', exact: true }).click();
    await expect(page.getByText('GAMMA test fixture', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan Swing PB', exact: true })).toBeEnabled();
    release();
    await page.clock.runFor(500);
    await expect(page.getByText('GAMMA test fixture', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { release(); }
});

test('a refresh that never settles times out and backs off without hiding saved cards', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
  let release!: () => void, posts = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/scan', async route => { posts++; await pending; await route.fulfill({ json: { stocks: [] } }); });
  try {
    await page.getByRole('button', { name: 'Scan Swing BO', exact: true }).click();
    await expect.poll(() => posts).toBe(1);
    await page.clock.fastForward(56000);
    await expect(page.getByRole('alert').filter({ hasText: 'Scan timed out.' })).toContainText('Scan timed out. Saved results are retained.');
    await expect(page.getByRole('button', { name: 'Scan Swing BO', exact: true })).toBeEnabled();
    await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Scan Swing BO', exact: true }).click();
    await page.clock.fastForward(30000);
    expect(posts).toBe(1);
  } finally { release(); }
});

test('409 exposes the running scan and polling recovers when a new snapshot arrives', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
  await page.route('**/api/scan', route => route.fulfill({ status: 409, headers: { 'Retry-After': '15' }, json: { error: 'Busy' } }));
  await page.getByRole('button', { name: 'Scan Swing BO', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Another scan is running.');
  await expect(page.getByRole('button', { name: 'Scan Swing BO', exact: true })).toBeEnabled();
  await page.route('**/api/scan?**', route => route.fulfill({ json: {
    stocks: [stock({ symbol: 'RECOVERED.NS', name: 'RECOVERED fixture' })],
    generatedAt: new Date(+NOW + 10000).toISOString(), expiresAt: new Date(+NOW + 3600000).toISOString(),
    cached: true, stale: false, status: 'ready', coverage: { requested: 261, attempted: 261, processed: 261, failed: [], deferred: [] },
  } }));
  await page.clock.fastForward(16000);
  await expect(page.getByText('RECOVERED fixture', { exact: true })).toBeVisible();
  await expect(page.getByText('Another scan is running.', { exact: false })).toHaveCount(0);
});

test('an unavailable scan is explained separately from a completed scan with no matches', async ({ page }) => {
  await setup(page);
  await expect(page.getByText('ALPHA test fixture', { exact: true })).toBeVisible();
  const snapshot = { stocks: [], generatedAt: NOW.toISOString(), expiresAt: new Date(+NOW + 300000).toISOString(), stale: false };
  await page.route('**/api/scan?**', route => route.fulfill({ json: { ...snapshot, status: 'unavailable', message: 'Market data could not be refreshed.', coverage: { requested: 261, processed: 0, failed: ['A.NS'], deferred: ['B.NS'] } } }));
  await page.getByRole('button', { name: 'BTST', exact: true }).click();
  await expect(page.getByText('Scan unavailable', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Market data could not be refreshed.');
  await page.route('**/api/scan?**', route => route.fulfill({ json: { ...snapshot, status: 'ready', coverage: { requested: 261, processed: 261, failed: [], deferred: [] } } }));
  await page.getByRole('button', { name: 'Swing PB', exact: true }).click();
  await expect(page.getByText('No matching setups', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan Swing PB', exact: true })).toBeEnabled();
});

test('records manual fills and reviews exits in the private portfolio', async ({page}) => {
  await setup(page);
  await page.getByRole('button',{name:'Portfolio & journal'}).click();
  await page.getByRole('spinbutton',{name:'Portfolio cash'}).fill('100000');
  await page.getByRole('button',{name:'Save cash & limits'}).click();
  await expect(page.getByText('₹100000.00').first()).toBeVisible();
  await page.getByRole('textbox',{name:'Fill symbol'}).fill('ALPHA');
  await page.getByRole('spinbutton',{name:'Fill quantity'}).fill('10');
  await page.getByRole('spinbutton',{name:'Fill price'}).fill('100');
  await page.getByLabel('Initial stop (optional)').fill('90');
  await page.getByLabel('First target').fill('110');
  await page.getByRole('button',{name:'Record fill',exact:true}).click();
  await expect(page.getByText('ALPHA.NS · 10 shares · average ₹100.00')).toBeVisible();
  await page.getByRole('spinbutton',{name:'Observed price ALPHA.NS'}).fill('112');
  await page.getByRole('button',{name:'Update observed price'}).click();
  await expect(page.getByText(/Observed price reached T1/)).toBeVisible();
});

test('Groww holdings remain clickable over the dashboard when the journal is unavailable', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await setup(page);
  await page.route('**/api/market-mood',route=>route.fulfill({json:{
    available:false,regime:'NEUTRAL',defensiveMode:true,regimeReason:'Market inputs stale'
  }}));
  await page.route('**/api/portfolio',route=>route.fulfill({status:503,json:{error:'Journal temporarily unavailable'}}));
  await page.route('**/api/broker',route=>route.fulfill({json:{
    holdings:[{symbol:'ALPHA.NS',quantity:7,averagePrice:100}]
  }}));
  await page.reload();
  await expect(page.getByText('Market data unverified.',{exact:true})).toBeVisible();
  await expect(page.getByText('Defensive Mode.',{exact:true})).toHaveCount(0);
  const opener=page.getByRole('button',{name:'Portfolio & journal'});
  await opener.click();
  const panel=page.getByRole('dialog',{name:'Portfolio & daily review'});
  const holdings=panel.getByRole('button',{name:'Read Groww holdings'});
  await expect(panel.getByRole('alert')).toHaveText('Journal temporarily unavailable');
  await expect(holdings).toBeInViewport();
  await holdings.click();
  await expect(panel.getByText(/ALPHA\.NS · Groww 7 shares · journal unavailable/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(opener).toBeFocused();
});

test('a partial scan poll preserves the selected chart and in-flight explanation', async ({page}) => {
  await setup(page);
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish=resolve; });
  let analyzeStarted = false;
  const analyzed = stock({cmp:1018});
  await page.route('**/api/analyze', async route => {
    analyzeStarted = true;
    await delayed;
    await route.fulfill({json:{
      stock:analyzed, analysis:{evidenceSelection:{technical:['price'],fundamental:[],news:[],risk:[]}},
      cachedAt:NOW.toISOString(), expiresAt:new Date(+NOW+3600000).toISOString(),
      cachedCmp:analyzed.cmp, fingerprint:guardFingerprint(analyzed), cached:false
    }});
  });
  await choose(page,'ALPHA');
  await expect.poll(()=>analyzeStarted).toBe(true);
  try {
    await page.route('**/api/scan?**', route=>route.fulfill({json:{
      stocks:[stock({symbol:'BETA.NS',name:'BETA partial snapshot'})],
      generatedAt:new Date(+NOW+15000).toISOString(),expiresAt:new Date(+NOW+3600000).toISOString(),
      status:'partial',cached:true,stale:false
    }}));
    await page.clock.fastForward(16000);
    await expect(page.getByText('BETA partial snapshot',{exact:true})).toBeVisible();
    await expect(page.getByText('ALPHA — Chart',{exact:true})).toBeVisible();
  } finally { finish(); }
  await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();
  await expect(page.getByText('₹1018.00',{exact:true}).first()).toBeVisible();
  await page.clock.fastForward(16000);
  await expect(page.getByText('AI explanation with quant guardrails',{exact:true})).toBeVisible();
  await expect(page.getByText('Setup updated.',{exact:false})).toHaveCount(0);
});

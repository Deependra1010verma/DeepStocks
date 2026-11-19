import { NSE_SCAN_UNIVERSE } from "@/lib/niftyStocks";
import { batchFetchStockData } from "@/lib/dataFetcher";
import { runScreener, type ScreenerMode, type ScreenedStock } from "@/lib/screenerEngine";
import { connectDB } from "@/lib/db";
import { ScanSnapshot, type IScanSnapshot, type RemovedScanStock } from "@/lib/models/ScanSnapshot";
import { dateToISTString, todayIST, nextMarketOpen, getMarketSession, cashSessionLimits } from "@/lib/timezone";
import { getMarketRegime } from "@/lib/marketRegime";
import { applyInstitutionalGuards, rankSectorCandidates } from "@/lib/riskGuards";
import { recheckDataQuality } from './dataQuality';
import { withLease, recordOperation, AppError } from './operations';
import { beforeDeadline, assertTimeRemaining, DeadlineError } from './deadline';
import { startScanProgress, advanceScanProgress, scanCoverage, scanRetrySymbols, type ScanCoverage, type ScanProgress } from './scanProgress';
import { getInstrumentMaster, instrumentMap } from './marketReference';
import { isBtstWindow } from './entrySignals';
import { getSectorBenchmarks, usesSectorBenchmark } from './sectorBenchmarks';
import { getNseEvents } from './nseCorporateEvents';
import { getNseSurveillance } from './nseSurveillance';
import { getNsePriceBands } from './nsePriceBands';
export const SCAN_VERSION = '2026-11-scan-v12';

const FAST_REFRESH_MODES: ScreenerMode[] = ["intraday", "btst", "swing_breakout", "swing_pullback"];
const FAST_TTL_MS = 15 * 60 * 1000;
const DAILY_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_PROJECTION = { 'stocks.candles': 0 };
type ScanStage = 'lease' | 'snapshot-read' | 'market-data' | 'risk-checks' | 'snapshot-write';
type ScanTrace = { stage: ScanStage; stages: Record<string, number> };

const inFlightScans = new Map<string, Promise<ScanResult>>();

export interface ScanResult {
  coverage?: ScanCoverage;
  progress?: ScanProgress;
  status?: 'ready' | 'partial' | 'unavailable';
  message?: string;
  stocks: ScreenedStock[];
  removedToday: RemovedScanStock[];
  generatedAt: Date;
  expiresAt: Date;
  cached: boolean;
}

export function normalizeScanMode(value: unknown): ScreenerMode {
  const mode = String(value ?? "swing_breakout") as ScreenerMode;
  const valid: ScreenerMode[] = ["intraday", "btst", "swing_breakout", "swing_pullback", "positional", "longterm"];
  return valid.includes(mode) ? mode : "swing_breakout";
}

export function normalizeSector(value: unknown): string {
  const sector = String(value ?? "All").trim();
  return sector || "All";
}

export function scanTtlMs(mode: ScreenerMode): number {
  return FAST_REFRESH_MODES.includes(mode) ? FAST_TTL_MS : DAILY_TTL_MS;
}

function nextEodRefreshAt(now: Date): Date {
  const today = new Date(`${dateToISTString(now)}T15:50:00+05:30`);
  const open = nextMarketOpen(now);
  return today > now && getMarketSession(now).calendarVerified && dateToISTString(open) !== dateToISTString(now) && getMarketSession(new Date(`${dateToISTString(now)}T10:00:00+05:30`)).state === 'LIVE'
    ? today : new Date(`${dateToISTString(open)}T15:50:00+05:30`);
}

function expiresAtForMode(mode: ScreenerMode, now: Date): Date {
  if(!FAST_REFRESH_MODES.includes(mode))return nextEodRefreshAt(now);
  if(getMarketSession(now).state!=='LIVE')return nextMarketOpen(now);
  const day=dateToISTString(now);
  const close=+new Date(`${day}T00:00:00+05:30`)+cashSessionLimits(day).continuousEnd*60_000;
  const nextBoundary=mode==='btst'&&!isBtstWindow(now)?close-30*60_000:close;
  return new Date(Math.min(+now+FAST_TTL_MS,nextBoundary));
}

function scanKey(mode: ScreenerMode, sector: string): string {
  return `${mode}:${sector}`;
}

function isFresh(snapshot: Pick<IScanSnapshot, "expiresAt">): boolean {
  return new Date(snapshot.expiresAt).getTime() > Date.now();
}

function serializeStock(stock: ScreenedStock, state: "NEW" | "ACTIVE", seenAt: Date, firstSeenAt?: string): ScreenedStock {
  const seen = seenAt.toISOString();
  return {
    ...stock,
    candles: [],
    lifecycleState: state,
    firstSeenAt: firstSeenAt ?? seen,
    lastSeenAt: seen,
  };
}

const qualifies = (stock: ScreenedStock) => !stock.nearMiss || stock.researchQualified === true;

function mergeRemovedToday(previous: IScanSnapshot | null, newlyRemoved: RemovedScanStock[]): RemovedScanStock[] {
  const date = todayIST();
  const old = (previous?.removedToday ?? []).filter((item) => dateToISTString(new Date(item.removedAt)) === date);
  const oldBySymbol = new Map(old.map((item) => [item.symbol, item]));
  const merged = newlyRemoved.map((item) => oldBySymbol.get(item.symbol) ?? item);
  merged.push(...old.filter((oldItem) => !newlyRemoved.some((item) => item.symbol === oldItem.symbol)));
  return merged
    .filter((item) => item.removedAt && dateToISTString(new Date(item.removedAt)) === date)
    .sort((a, b) => new Date(b.removedAt).getTime() - new Date(a.removedAt).getTime())
    .slice(0, 100)
    .map((item) => ({ ...item, removedAt: new Date(item.removedAt), lastSeenAt: new Date(item.lastSeenAt) }));
}

async function runLiveScan(
  mode: ScreenerMode, previous: IScanSnapshot | null, deadline: number, signal: AbortSignal, trace: ScanTrace
): Promise<ScanResult> {
  const start = Date.now();
  const symbols = NSE_SCAN_UNIVERSE.map(s => s.symbol);
  const previousProgress=previous?.version===SCAN_VERSION?previous.progress:undefined;
  const newBtstWindow=mode==='btst'&&isBtstWindow()&&previousProgress&&!isBtstWindow(new Date(previousProgress.startedAt));
  const progress = startScanProgress(symbols, newBtstWindow?undefined:previousProgress);
  const resumed = previous?.progress?.startedAt === progress.startedAt;
  // Acquire a bounded portion. The rest is persisted for the next request/cron.
  const batchStart = Date.now();
  const qualityMode = mode === 'positional' || mode === 'longterm';
  trace.stage = 'market-data';
  const eventsPromise = beforeDeadline(getNseEvents, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => new Map());
  const surveillancePromise = beforeDeadline(getNseSurveillance, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => new Map());
  const bandsPromise = beforeDeadline(getNsePriceBands, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => new Map());
  const benchmarkPromise = usesSectorBenchmark(mode) && !progress.sectorBenchmarks
    ? beforeDeadline(getSectorBenchmarks, Math.min(deadline - 8500, Date.now() + 5200), signal).catch(() => [])
    : Promise.resolve(progress.sectorBenchmarks ?? []);
  const marketPromise = beforeDeadline(() => getMarketRegime(), Math.min(deadline, Date.now() + 18000), signal).catch(() => ({ available: false, regime: 'NEUTRAL' as const, defensiveMode: true, riskMultiplier: 0, positionRiskPercent: 0, reason: 'Market regime unavailable; new risk blocked', niftyClose: null, niftyEma20: null, niftyEma50: null, indiaVix: null, generatedAt: new Date().toISOString() }));
  const instrumentsPromise = getInstrumentMaster().then(instrumentMap);
  const reserveMs=deadline-start<27000?6500:14000;
  const stockData = await batchFetchStockData(progress.deferred.slice(0, qualityMode ? 20 : 60), mode === 'intraday' ? '15m' : '1d', qualityMode, mode !== 'intraday', Math.min(deadline - reserveMs, Date.now() + (qualityMode ? 18000 : 24000)), signal, {
    withBtstConfirmation: mode === 'btst',
    sessionInstruments: mode === 'intraday' ? instrumentsPromise : undefined
  });
  trace.stages.fetchMs = Date.now() - batchStart;
  assertTimeRemaining(deadline, signal);
  const verified = [...stockData].filter(([,item]) => item.dataQuality && !item.dataQuality.stale).map(([symbol]) => symbol);
  const verifiedSymbols=new Set(verified);
  const nextProgress = advanceScanProgress(progress, stockData.coverage.attempted, [...stockData.keys()], verified);
  const benchmarks = await benchmarkPromise;
  if (usesSectorBenchmark(mode)) nextProgress.sectorBenchmarks = benchmarks;
  const bySector = new Map(benchmarks.map(item => [item.sector,item]));
  for (const [symbol, data] of stockData) {
    data.sector = NSE_SCAN_UNIVERSE.find(s => s.symbol === symbol)?.sector ?? 'Unknown';
    data.sectorBenchmark = bySector.get(data.sector);
  }
  const evaluated = runScreener(mode, stockData);
  const previousQualified = new Set((previous?.stocks ?? []).filter(s=>qualifies(s)||s.awaitingRevalidation).map(s=>s.symbol));
  const near = new Set(evaluated.filter(s => s.nearMiss).slice(0, 10).map(s => s.symbol));
  const candidates = evaluated.filter(s => !s.nearMiss || previousQualified.has(s.symbol) || near.has(s.symbol));
  const guardStart = Date.now();
  trace.stage = 'risk-checks';
  const [market,instruments,events,surveillance,priceBands] = await Promise.all([marketPromise,instrumentsPromise,eventsPromise,surveillancePromise,bandsPromise]);
  const screened = await beforeDeadline(() => applyInstitutionalGuards(mode, candidates, stockData, market, deadline - 5500,instruments,{events,surveillance,priceBands}), deadline - 5000, signal);
  trace.stages.guardsMs = Date.now() - guardStart;
  assertTimeRemaining(deadline - 3500, signal);
  const now = new Date(), previousBySymbol = new Map((previous?.stocks ?? []).map(s => [s.symbol, s]));
  const stocks = screened.map(stock => {
    const old = previousBySymbol.get(stock.symbol);
    const wasQualified=previousQualified.has(stock.symbol);
    return serializeStock(
      {...stock,awaitingRevalidation:wasQualified&&!verifiedSymbols.has(stock.symbol)},
      wasQualified&&qualifies(stock) ? 'ACTIVE' : 'NEW',
      now,
      wasQualified||!qualifies(stock)?old?.firstSeenAt:undefined
    );
  });
  const completedThisCycle = new Set(progress.processed);
  for (const old of previous?.stocks ?? []) if (!stockData.has(old.symbol)) {
    if (resumed && completedThisCycle.has(old.symbol)) stocks.push({ ...old, candles: [] });
    else stocks.push({ ...old, candles: [], nearMiss: true, researchQualified:false, awaitingRevalidation:previousQualified.has(old.symbol), dataQuality: old.dataQuality ? { ...old.dataQuality, stale: true, issues: ['Awaiting current scan data'] } : undefined, guardReasons: ['Awaiting current scan data — previous setup cannot be revalidated'] });
  }
  // Keep all qualifiers; bound retained near-miss cards without hiding coverage.
  const ranked = rankSectorCandidates(stocks);
  const pendingOrNear = ranked.filter(s=>!qualifies(s));
  const displayStocks = [
    ...ranked.filter(qualifies),
    ...pendingOrNear.filter(s=>s.awaitingRevalidation),
    ...pendingOrNear.filter(s=>!s.awaitingRevalidation).slice(0,20)
  ];
  const bySymbol = new Map(screened.map(s => [s.symbol, s]));
  const newlyRemoved: RemovedScanStock[] = [];
  for (const old of previous?.stocks ?? []) {
    const current = bySymbol.get(old.symbol);
    if (previousQualified.has(old.symbol) && verifiedSymbols.has(old.symbol) && (!current || !qualifies(current))) newlyRemoved.push({ symbol: old.symbol, name: old.name, sector: old.sector, quantScore: old.quantScore, reason: current?.guardReasons?.join('; ') || 'Insufficient valid candles to revalidate strategy', removedAt: now, lastSeenAt: new Date(old.lastSeenAt ?? previous!.generatedAt) });
  }
  const active = new Set(displayStocks.filter(qualifies).map(s=>s.symbol));
  const removedToday = mergeRemovedToday(previous, newlyRemoved).filter(s => !active.has(s.symbol));
  const coverage = scanCoverage(nextProgress, symbols.length);
  const pending=nextProgress.deferred.length;
  const failed=nextProgress.failed.length;
  const unverified=coverage.processed-(coverage.verified??coverage.processed);
  const status = !coverage.processed||(!coverage.verified&&!pending) ? 'unavailable' : pending||failed||unverified ? 'partial' : 'ready';
  const message = status === 'unavailable'
    ? 'Current market data could not be verified. Previous results remain available for review.'
    : status === 'partial'
      ? `${coverage.processed}/${coverage.requested} processed · ${coverage.verified} data-verified · ${pending} pending · ${failed} unavailable.`
      : undefined;
  // Continue successful work, but back off an outage instead of a blind retry loop.
  const retryingIncomplete=scanRetrySymbols(nextProgress).length>0;
  const retryMs = stockData.size&&pending ? 20000 : retryingIncomplete ? 60000 : 300000;
  const expiresAt = status!=='unavailable'&&!pending&&!failed&&!retryingIncomplete ? expiresAtForMode(mode, now) : new Date(+now + retryMs);
  return { stocks: displayStocks, removedToday, generatedAt: stockData.size ? now : new Date(previous?.generatedAt ?? now), expiresAt, cached: false, coverage, progress: nextProgress, status, message };
}

async function saveSnapshot(
  mode: ScreenerMode, previous: IScanSnapshot | null, result: ScanResult, deadline: number, signal: AbortSignal
): Promise<void> {
  const identity = { mode, sector: 'All' };
  const updatedAt = new Date(Math.max(Date.now(), +(previous?.updatedAt ?? 0) + 1));
  try {
    const saved = await beforeDeadline(() => ScanSnapshot.updateOne(
      { ...identity, updatedAt: previous?.updatedAt ?? { $exists: false } },
    {
      $set: {
        ...identity,
        version: SCAN_VERSION,
        coverage: result.coverage,
        progress: result.progress,
        status: result.status,
        message: result.message,
        stocks: result.stocks,
        removedToday: result.removedToday,
        generatedAt: result.generatedAt,
        expiresAt: result.expiresAt,
        updatedAt,
      },
    },
      { upsert: previous === null, maxTimeMS: 2800 }
    ), Math.min(deadline - 1100, Date.now() + 3300), signal);
    if (saved.matchedCount === 0 && saved.upsertedCount === 0)
      throw new AppError('SNAPSHOT_ADVANCED', 'Another batch saved a newer snapshot. Refresh to continue.', 409, 5);
  } catch (error) {
    if ((error as { code?: number })?.code === 11000)
      throw new AppError('SNAPSHOT_ADVANCED', 'Another batch saved a newer snapshot. Refresh to continue.', 409, 5);
    if (error instanceof AppError) throw error;
    // A database can commit the write even when the acknowledgment is lost.
    const confirmed = await beforeDeadline(
      () => ScanSnapshot.findOne({ ...identity, updatedAt, version: SCAN_VERSION }, { _id: 1 }).maxTimeMS(750).lean(),
      deadline, signal
    ).catch(() => null);
    if (!confirmed)
      throw new AppError('SNAPSHOT_WRITE_UNCONFIRMED', 'Could not confirm the snapshot save. The next refresh checks saved progress.', 503, 15);
  }
}

export async function getCachedScan(mode: ScreenerMode, sector: string): Promise<ScanResult | null> {
  try {
    await beforeDeadline(() => connectDB(), Date.now() + 3500);
    const snapshot = await beforeDeadline(() => ScanSnapshot.findOne({ mode, sector: "All" }, SNAPSHOT_PROJECTION).maxTimeMS(2000).lean<IScanSnapshot>(), Date.now() + 5000);
    if (!snapshot) return null;
    return {
      stocks: snapshot.stocks.filter(s=>sector==='All'||s.sector===sector).map(s=>{
        const quality = s.dataQuality ? recheckDataQuality(s.dataQuality,mode==='intraday') : undefined;
        const incompatible = snapshot.version !== SCAN_VERSION;
        const sessionEnded = (mode==='intraday'||mode==='btst') && getMarketSession(new Date(),s.casEligible??null).state!=='LIVE';
        const reasons = [...(s.guardReasons??[])];
        if(incompatible) reasons.push('Calculations need refreshing after engine update');
        if(!quality||quality.stale) reasons.push('Data freshness requires revalidation');
        if(sessionEnded) reasons.push('Continuous trading session is not confirmed open');
        return {...s,candles:[],dataQuality:quality,researchQualified:s.researchQualified&&!incompatible&&!!quality&&!quality.stale,nearMiss:Boolean(s.nearMiss||!quality||quality.stale||incompatible||sessionEnded),guardReasons:[...new Set(reasons)]};
      }),
      coverage: snapshot.coverage,
      status: snapshot.status,
      message: snapshot.message,
      removedToday: snapshot.removedToday.filter(s=>dateToISTString(new Date(s.removedAt))===todayIST()&&(sector==='All'||s.sector===sector)),
      generatedAt: new Date(snapshot.generatedAt),
      expiresAt: snapshot.version === SCAN_VERSION ? new Date(snapshot.expiresAt) : new Date(0),
      cached: true,
    };
  } catch {
    throw new AppError('SNAPSHOT_UNAVAILABLE','Snapshot storage is unavailable. Please retry shortly.',503,15);
  }
}

export async function getOrCreateScan(mode: ScreenerMode, sector: string): Promise<ScanResult> {
  const cached = await getCachedScan(mode, sector);
  if (cached) return { ...cached, cached: true };

  return refreshScan(mode, sector);
}

export async function refreshScan(mode: ScreenerMode, sector: string, requestDeadline?:number): Promise<ScanResult> {
  const key = scanKey(mode,'All');
  const deadline = Math.min(Date.now() + 42000,requestDeadline??Infinity);
  const cached = await getCachedScan(mode,sector);
  if (cached && !snapshotIsStale(cached)) return cached;
  let promise = inFlightScans.get(key);
  if (!promise) {
    if(deadline-Date.now()<12000)throw new AppError('SCAN_START_TIMEOUT','Scan budget unavailable; continuation will retry.',503,60);
    const controller = new AbortController();
    const trace: ScanTrace = { stage: 'lease', stages: {} };
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    // One shared acquisition job at a time prevents six tabs flooding Yahoo's queue.
    promise = beforeDeadline(() => withLease('scan:market-data', async () => {
      trace.stage = 'snapshot-read';
      const readStarted = Date.now();
      const previous = await beforeDeadline(() => ScanSnapshot.findOne({ mode, sector: 'All' }, SNAPSHOT_PROJECTION).maxTimeMS(2400).lean<IScanSnapshot>(), Math.min(deadline, Date.now() + 4500), controller.signal);
      trace.stages.snapshotMs = Date.now() - readStarted;
      const result = await runLiveScan(mode, previous, deadline, controller.signal, trace);
      assertTimeRemaining(deadline - 3500, controller.signal);
      trace.stage = 'snapshot-write';
      const writeStarted = Date.now();
      await saveSnapshot(mode, previous, result, deadline, controller.signal);
      trace.stages.writeMs = Date.now() - writeStarted;
      await beforeDeadline(() => recordOperation(`scan:${mode}`, {
        status: result.status, stage: 'complete', code: null, coverage: result.coverage,
        stages: trace.stages, latencyMs: Date.now() - startedAt
      }), Math.min(deadline, Date.now() + 600), controller.signal).catch(() => undefined);
      return result;
    }, 60000), deadline, controller.signal).catch(async error => {
      if (error instanceof AppError && error.status === 409) throw error;
      const failure = error instanceof AppError ? error
        : error instanceof DeadlineError ? new AppError('SCAN_TIMEOUT', 'Scan timed out. Saved results are retained.', 504, 30)
          : new AppError('SCAN_DEPENDENCY_UNAVAILABLE', 'A scan dependency failed. Saved results are retained.', 503, 15);
      await beforeDeadline(() => recordOperation(`scan:${mode}`, {
        status: 'failed', stage: trace.stage, code: failure.code, stages: trace.stages, latencyMs: Date.now() - startedAt
      }), Date.now() + 500).catch(() => undefined);
      throw failure;
    }).finally(() => { controller.abort(); clearTimeout(timer); inFlightScans.delete(key); });
    inFlightScans.set(key,promise);
  }
  const result = await promise;
  return {...result,stocks:result.stocks.filter(s=>sector==='All'||s.sector===sector),removedToday:result.removedToday.filter(s=>sector==='All'||s.sector===sector)};
}

export function snapshotIsStale(result: Pick<ScanResult, "expiresAt">): boolean {
  return !isFresh(result);
}

import { NSE_SCAN_UNIVERSE } from "@/lib/niftyStocks";
import { batchFetchStockData } from "@/lib/dataFetcher";
import { runScreener, type ScreenerMode, type ScreenedStock } from "@/lib/screenerEngine";
import { connectDB } from "@/lib/db";
import { ScanSnapshot, type IScanSnapshot, type RemovedScanStock } from "@/lib/models/ScanSnapshot";
import { calendarDay, dateToISTString, todayIST, nextMarketOpen, getMarketSession, cashSessionLimits, sessionTime } from "@/lib/timezone";
import { getMarketRegime } from "@/lib/marketRegime";
import { applyInstitutionalGuards, rankSectorCandidates } from "@/lib/riskGuards";
import { recheckDataQuality } from './dataQuality';
import { withLease, recordOperation, AppError } from './operations';
import { beforeDeadline, assertTimeRemaining, DeadlineError } from './deadline';
import { startScanProgress, advanceScanProgress, scanCoverage, scanRetrySymbols, type ScanCoverage, type ScanProgress } from './scanProgress';
import { getInstrumentMaster, instrumentMap } from './marketReference';
import { isBtstWindow } from './entrySignals';
import { getSectorBenchmarks, usesSectorBenchmark } from './sectorBenchmarks';
import { getNseEventReports } from './nseCorporateEvents';
import { getNseSurveillanceReports } from './nseSurveillance';
import { getNsePriceBands } from './nsePriceBands';
import { referenceEntryReasons } from './entryClearance';
import { marketEntryReasons, qualifiesForShortlist as qualifies } from './strategyPolicy';
export const SCAN_VERSION = '2026-11-scan-v16';

const FAST_REFRESH_MODES: ScreenerMode[] = ["intraday", "btst", "swing_breakout", "swing_pullback"];
const FAST_TTL_MS = 15 * 60 * 1000;
const DAILY_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_PROJECTION = { 'stocks.candles': 0 };
type ScanStage = 'lease' | 'snapshot-read' | 'market-data' | 'risk-checks' | 'snapshot-write';
type ScanTrace = { stage: ScanStage; stages: Record<string, number> };

const inFlightScans = new Map<string, Promise<ScanResult>>();
const inFlightSnapshotReads = new Map<ScreenerMode, Promise<IScanSnapshot | null>>();

export type SnapshotReadTiming = Partial<Record<'connect' | 'query' | 'shared' | 'render', number>>;

export interface ScanResult {
  coverage?: ScanCoverage;
  progress?: ScanProgress;
  status?: 'ready' | 'partial' | 'unavailable';
  message?: string;
  stocks: ScreenedStock[];
  removedToday: RemovedScanStock[];
  generatedAt: Date;
  updatedAt?: Date;
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
  const day = dateToISTString(now);
  const today = sessionTime(day, 950);
  const open = nextMarketOpen(now);
  return today > now && calendarDay(day).trading && dateToISTString(open) !== day
    ? today : sessionTime(dateToISTString(open), 950);
}

function expiresAtForMode(mode: ScreenerMode, now: Date): Date {
  if(!FAST_REFRESH_MODES.includes(mode))return nextEodRefreshAt(now);
  if(getMarketSession(now).state!=='LIVE')return nextMarketOpen(now);
  const day=dateToISTString(now);
  const close=+sessionTime(day, cashSessionLimits(day).continuousEnd);
  const upcomingBtstStarts = [true,false].map(cas => +sessionTime(day, cashSessionLimits(day, cas).continuousEnd - 30))
    .filter(start => start > +now);
  const nextBoundary = mode === 'btst' ? Math.min(close, ...upcomingBtstStarts) : close;
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

function savedStockClearance(stock: ScreenedStock, mode: ScreenerMode, now: Date, today: string) {
  const quality = stock.dataQuality ? recheckDataQuality(stock.dataQuality, mode === 'intraday', now) : undefined;
  const reasons = referenceEntryReasons(stock, now);
  if (!quality || quality.stale) reasons.push('Data freshness requires revalidation');
  const cas = stock.tickSizeAsOf === today ? stock.casEligible ?? null : null;
  if ((mode === 'intraday' || mode === 'btst') && getMarketSession(now, cas).state !== 'LIVE') {
    reasons.push('Continuous trading session is not confirmed open');
  }
  return { quality, reasons };
}

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
  const nowAtStart = new Date(start);
  const newBtstWindow = mode === 'btst' && previousProgress && [true,false].some(cas =>
    isBtstWindow(nowAtStart, cas) && !isBtstWindow(new Date(previousProgress.startedAt), cas));
  const progress = startScanProgress(symbols, newBtstWindow?undefined:previousProgress);
  const resumed = previous?.progress?.startedAt === progress.startedAt;
  // Acquire a bounded portion. The rest is persisted for the next request/cron.
  const batchStart = Date.now();
  const qualityMode = mode === 'positional' || mode === 'longterm';
  trace.stage = 'market-data';
  const eventsPromise = beforeDeadline(getNseEventReports, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => undefined);
  const surveillancePromise = beforeDeadline(getNseSurveillanceReports, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => undefined);
  const bandsPromise = beforeDeadline(getNsePriceBands, Math.min(deadline - 8500, Date.now() + 4500), signal).catch(() => new Map());
  const benchmarkPromise = usesSectorBenchmark(mode) && !progress.sectorBenchmarks
    ? beforeDeadline(getSectorBenchmarks, Math.min(deadline - 8500, Date.now() + 5200), signal).catch(() => [])
    : Promise.resolve(progress.sectorBenchmarks ?? []);
  const marketPromise = beforeDeadline(() => getMarketRegime(), Math.min(deadline, Date.now() + 18000), signal).catch(() => ({ available: false, regime: 'NEUTRAL' as const, defensiveMode: true, riskMultiplier: 0, positionRiskPercent: 0, reason: 'Market regime unavailable; new risk blocked', niftyClose: null, niftyEma20: null, niftyEma50: null, indiaVix: null, generatedAt: new Date().toISOString() }));
  const instrumentsPromise = getInstrumentMaster().then(instrumentMap);
  const reserveMs=deadline-start<27000?6500:14000;
  const stockData = await batchFetchStockData(progress.deferred.slice(0, qualityMode ? 20 : 60), mode === 'intraday' ? '15m' : '1d', qualityMode, mode !== 'intraday', Math.min(deadline - reserveMs, Date.now() + (qualityMode ? 18000 : 24000)), signal, {
    withBtstConfirmation: mode === 'btst',
    sessionInstruments: instrumentsPromise
  });
  trace.stages.fetchMs = Date.now() - batchStart;
  assertTimeRemaining(deadline, signal);
  const benchmarks = await benchmarkPromise;
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
  const verifiedSymbols = new Set([...stockData].filter(([, item]) => item.dataQuality && !item.dataQuality.stale).map(([symbol]) => symbol));
  for (const stock of screened) if (stock.dataQuality?.stale) verifiedSymbols.delete(stock.symbol);
  const nextProgress = advanceScanProgress(progress, stockData.coverage.attempted, [...stockData.keys()], [...verifiedSymbols]);
  if (usesSectorBenchmark(mode)) nextProgress.sectorBenchmarks = benchmarks;
  const stocks = screened.map(stock => {
    const old = previousBySymbol.get(stock.symbol);
    const wasQualified=previousQualified.has(stock.symbol);
    return serializeStock(
      {...stock,awaitingRevalidation:wasQualified &&
        (!verifiedSymbols.has(stock.symbol) || (!!stock.referenceCoverage && referenceEntryReasons(stock, now).length > 0))},
      wasQualified&&qualifies(stock) ? 'ACTIVE' : 'NEW',
      now,
      wasQualified||!qualifies(stock)?old?.firstSeenAt:undefined
    );
  });
  const completedThisCycle = new Set(progress.processed);
  const noLongerVerified = new Set<string>();
  const today = dateToISTString(now);
  for (const old of previous?.stocks ?? []) if (!stockData.has(old.symbol)) {
    if (resumed && completedThisCycle.has(old.symbol)) {
      const { quality, reasons } = savedStockClearance(old, mode, now, today);
      if (!quality || quality.stale) noLongerVerified.add(old.symbol);
      reasons.push(...marketEntryReasons(mode, old.rvol, market));
      const nearMiss = Boolean(old.nearMiss || reasons.length);
      stocks.push({
        ...old, candles: [], dataQuality: quality, nearMiss,
        researchQualified: old.researchQualified && !reasons.length,
        awaitingRevalidation: old.awaitingRevalidation || (qualifies(old) && reasons.length > 0),
        positionRiskPercent: nearMiss ? 0 : Math.min(old.positionRiskPercent ?? 0, market.positionRiskPercent),
        regime: market.regime, regimeReason: market.reason, riskMultiplier: market.riskMultiplier, defensiveMode: market.defensiveMode,
        guardReasons: [...new Set([...(old.guardReasons ?? []), ...reasons])],
      });
    } else {
      stocks.push({ ...old, candles: [], nearMiss: true, researchQualified: false, positionRiskPercent: 0,
        awaitingRevalidation: previousQualified.has(old.symbol),
        dataQuality: old.dataQuality ? { ...old.dataQuality, stale: true, issues: ['Awaiting current scan data'] } : undefined,
        guardReasons: ['Awaiting current scan data — previous setup cannot be revalidated'],
      });
    }
  }
  nextProgress.verified = nextProgress.verified?.filter(symbol => !noLongerVerified.has(symbol));
  // Keep all qualifiers; bound retained near-miss cards without hiding coverage.
  const ranked = rankSectorCandidates(stocks);
  const pendingOrNear = ranked.filter(s=>!qualifies(s));
  const displayStocks = [
    ...ranked.filter(qualifies),
    ...pendingOrNear.filter(s=>s.awaitingRevalidation),
    ...pendingOrNear.filter(s=>!s.awaitingRevalidation).slice(0,20)
  ];
  const bySymbol = new Map(stocks.map(s => [s.symbol, s]));
  const newlyRemoved: RemovedScanStock[] = [];
  for (const old of previous?.stocks ?? []) {
    const current = bySymbol.get(old.symbol);
    if (previousQualified.has(old.symbol) && verifiedSymbols.has(old.symbol) && !current?.awaitingRevalidation && (!current || !qualifies(current))) newlyRemoved.push({ symbol: old.symbol, name: old.name, sector: old.sector, quantScore: old.quantScore, reason: current?.guardReasons?.join('; ') || 'Insufficient valid candles to revalidate strategy', removedAt: now, lastSeenAt: new Date(old.lastSeenAt ?? previous!.generatedAt) });
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
): Promise<Date> {
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
  return updatedAt;
}

async function readSnapshot(mode: ScreenerMode, timing?: SnapshotReadTiming): Promise<IScanSnapshot | null> {
  let started = performance.now();
  try {
    await beforeDeadline(() => connectDB(), Date.now() + 3500);
  } finally {
    if (timing) timing.connect = performance.now() - started;
  }
  started = performance.now();
  try {
    return await beforeDeadline(() => ScanSnapshot.findOne({ mode, sector: 'All' }, SNAPSHOT_PROJECTION).maxTimeMS(2000).lean<IScanSnapshot>(), Date.now() + 5000);
  } finally {
    if (timing) timing.query = performance.now() - started;
  }
}

// All sectors use the same document. Share only pending GET reads, including failures.
async function readSharedSnapshot(mode: ScreenerMode, timing: SnapshotReadTiming): Promise<IScanSnapshot | null> {
  const pending = inFlightSnapshotReads.get(mode);
  if (pending) {
    const started = performance.now();
    try {
      return await pending;
    } finally {
      timing.shared = performance.now() - started;
    }
  }
  const request = readSnapshot(mode, timing).finally(() => inFlightSnapshotReads.delete(mode));
  inFlightSnapshotReads.set(mode, request);
  return request;
}

export async function getCachedScan(mode: ScreenerMode, sector: string, getTiming?: SnapshotReadTiming): Promise<ScanResult | null> {
  try {
    const snapshot = await (getTiming ? readSharedSnapshot(mode, getTiming) : readSnapshot(mode));
    if (!snapshot) return null;
    const started = performance.now();
    const now = new Date();
    const today = dateToISTString(now);
    const incompatible = snapshot.version !== SCAN_VERSION;
    const expired = !(+new Date(snapshot.expiresAt) > +now);
    const inSector = (stock: Pick<ScreenedStock, 'sector'>) => sector === 'All' || stock.sector === sector;
    const checked = snapshot.stocks.filter(inSector).map(s=>{
      const { quality, reasons: clearance } = savedStockClearance(s, mode, now, today);
      const reasons = [...(s.guardReasons ?? []), ...clearance];
      if(incompatible) reasons.push('Calculations need refreshing after engine update');
      if(expired) reasons.push('Scan snapshot expired; refresh to revalidate');
      const nearMiss = Boolean(s.nearMiss || incompatible || expired || clearance.length);
      return {...s,candles:[],dataQuality:quality,researchQualified:s.researchQualified&&!incompatible&&!!quality&&!quality.stale,nearMiss,positionRiskPercent:nearMiss?0:s.positionRiskPercent,guardReasons:[...new Set(reasons)]};
    });
    const result: ScanResult = {
      stocks: mode === 'longterm' ? rankSectorCandidates(checked) : checked,
      coverage: snapshot.coverage,
      status: snapshot.status,
      message: snapshot.message,
      removedToday: snapshot.removedToday.filter(s=>dateToISTString(new Date(s.removedAt))===today&&inSector(s)),
      generatedAt: new Date(snapshot.generatedAt),
      updatedAt: snapshot.updatedAt,
      expiresAt: incompatible ? new Date(0) : new Date(snapshot.expiresAt),
      cached: true,
    };
    if (getTiming) getTiming.render = performance.now() - started;
    return result;
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
      const updatedAt = await saveSnapshot(mode, previous, result, deadline, controller.signal);
      trace.stages.writeMs = Date.now() - writeStarted;
      await beforeDeadline(() => recordOperation(`scan:${mode}`, {
        status: result.status, stage: 'complete', code: null, coverage: result.coverage,
        stages: trace.stages, latencyMs: Date.now() - startedAt
      }), Math.min(deadline, Date.now() + 600), controller.signal).catch(() => undefined);
      return { ...result, updatedAt };
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

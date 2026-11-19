"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  RefreshCw, TrendingUp, Activity, BarChart2, Target, Clock,
  Zap, ChevronDown, Layers, Search
} from "lucide-react";
import MarketRegimeBadge, { type SectorStrength } from "@/components/MarketRegimeBadge";
import StockList from "@/components/StockList";
import dynamic from "next/dynamic";
import AIReportCard from "@/components/AIReportCard";
import PortfolioDesk from '@/components/PortfolioDesk';
import { ScreenedStock, ScreenerMode } from "@/lib/screenerEngine";
import type { AIAnalysisResult } from "@/lib/aiAnalyst";
import { SECTORS } from "@/lib/niftyStocks";
import AccessGate from '@/components/AccessGate';
import OperationsStatus from '@/components/OperationsStatus';
import { guardFingerprint, priceMovedBeyondCache, ANALYSIS_VERSION } from '@/lib/aiCachePolicy';
import { getTradePlan } from '@/lib/tradePlan';
import { referenceEntryReasons } from '@/lib/entryClearance';
import { marketEntryReasons, qualifiesForShortlist } from '@/lib/strategyPolicy';
import { recheckDataQuality } from '@/lib/dataQuality';
import { clientProviderVersion, clientAIConfigured } from '@/lib/clientProvider';
import { beforeDeadline } from '@/lib/deadline';
import { dateToISTString, getMarketSession } from '@/lib/timezone';
import type { RemovedScanStock } from "@/lib/models/ScanSnapshot";

const CandlestickChart = dynamic(() => import("@/components/CandlestickChart"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <div className="flex items-center gap-2 text-slate-500">
        <div className="w-4 h-4 rounded-full border-2 border-t-cyan-500 border-cyan-900 animate-spin" />
        <span className="text-xs">Loading chart...</span>
      </div>
    </div>
  ),
});

interface MarketMood {
  available?: boolean;
  regime: "BULLISH" | "NEUTRAL" | "BEARISH";
  niftyClose: string | null;
  ema20: string | null;
  ema50: string | null;
  indiaVix?: string | null;
  defensiveMode?: boolean;
  riskMultiplier?: number;
  positionRiskPercent?: number;
  regimeReason?: string | null;
  message: string | null;
  session?: {
    state: "PRE_OPEN" | "LIVE" | "CLOSED" | "UNKNOWN";
    label: string;
    message: string;
    timeIST: string;
  };
}

interface ModeConfig {
  key: ScreenerMode;
  label: string;
  icon: React.ReactNode;
  desc: string;
}

interface ScanPayload {
  status?: 'ready' | 'partial' | 'unavailable';
  message?: string;
  needsRefresh?: boolean;
  coverage?: {requested:number;attempted?:number;processed:number;verified?:number;failed:string[];deferred?:string[]};
  stocks?: ScreenedStock[];
  removedToday?: RemovedScanStock[];
  generatedAt?: string;
  updatedAt?: string;
  expiresAt?: string;
  stale?: boolean;
  cached?: boolean;
}

interface ScanPermission {
  revision: number;
  nearMiss: boolean;
  riskPercent: number;
  reasons: string[];
}

function permissionKey(mode: ScreenerMode, symbol: string) {
  return `${mode}:${symbol}`;
}

function withScanPermission(stock: ScreenedStock, permission?: ScanPermission): ScreenedStock {
  if (!permission) return stock;
  const riskPercent = stock.positionRiskPercent ?? 0;
  if (!permission.nearMiss && permission.riskPercent >= riskPercent) return stock;
  return {
    ...stock,
    nearMiss: Boolean(stock.nearMiss || permission.nearMiss),
    positionRiskPercent: Math.min(riskPercent, permission.riskPercent),
    guardReasons: [...new Set([...(stock.guardReasons ?? []), ...permission.reasons])]
  };
}

interface LedgerInsights {
  closed: number;
  wins: number;
  winRate: number | null;
  byRvol?: {
    high: { winRate: number | null; closed: number };
    low: { winRate: number | null; closed: number };
  };
}

interface AnalysisMeta {
  cached: boolean;
  cachedAt: string;
  expiresAt: string;
}

interface AnalysisFailure {
  message: string;
  code?: string;
}

interface BrowserAnalysisCacheEntry {
  analysis: AIAnalysisResult;
  cachedAt: string;
  expiresAt: string;
  cachedCmp: number;
  fingerprint: string;
  stock: ScreenedStock;
}

const browserAnalysisCache = new Map<string, BrowserAnalysisCacheEntry>();
const BROWSER_CACHE_PREFIX = `deepstocks:ai:${ANALYSIS_VERSION}:`;

function browserCacheKey(stock: ScreenedStock, regime: string) {
  return `${BROWSER_CACHE_PREFIX}${clientProviderVersion()}:${stock.symbol}:${stock.mode}:${regime}`;
}

function evidenceTime(stock: ScreenedStock) {
  return Date.parse(stock.dataQuality?.fetchedAt ?? '') || 0;
}

function withMarketPermission(stock: ScreenedStock, market: MarketMood | null): ScreenedStock {
  if (!market || stock.mode === 'longterm') return stock;
  const reasons = marketEntryReasons(stock.mode, stock.rvol, market);
  if (reasons.length) return {
    ...stock,
    nearMiss: true,
    positionRiskPercent: 0,
    guardReasons: [...new Set([...(stock.guardReasons ?? []), ...reasons])]
  };
  const cap = market.positionRiskPercent;
  return cap !== undefined && cap < (stock.positionRiskPercent ?? 0)
    ? { ...stock, positionRiskPercent: cap }
    : stock;
}

function isOlderStock(incoming: ScreenedStock, current: ScreenedStock) {
  if (incoming.symbol !== current.symbol || incoming.mode !== current.mode) return true;
  const delta = evidenceTime(incoming) - evidenceTime(current);
  return delta < 0 || (delta === 0 && (
    incoming.cmp !== current.cmp || guardFingerprint(incoming) !== guardFingerprint(current)
  ));
}

function readBrowserAnalysis(stock: ScreenedStock, regime: string): BrowserAnalysisCacheEntry | null {
  const key = browserCacheKey(stock, regime);
  let entry = browserAnalysisCache.get(key);
  if (!entry && typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage.getItem(key);
      entry = raw ? JSON.parse(raw) as BrowserAnalysisCacheEntry : undefined;
      if (entry) browserAnalysisCache.set(key, entry);
    } catch {
      entry = undefined;
    }
  }
  if (!entry || new Date(entry.expiresAt).getTime() <= Date.now()) return null;
  if (entry.fingerprint !== guardFingerprint(stock) || priceMovedBeyondCache(stock.mode, entry.cachedCmp, stock.cmp)) return null;
  if (!stock.dataQuality || recheckDataQuality(stock.dataQuality,stock.mode==='intraday').stale) return null;
  return entry;
}

function writeBrowserAnalysis(stock: ScreenedStock, regime: string, entry: BrowserAnalysisCacheEntry) {
  const key = browserCacheKey(stock, regime);
  browserAnalysisCache.set(key, entry);
  if (typeof window !== "undefined") {
    try { window.sessionStorage.setItem(key, JSON.stringify(entry)); } catch { /* storage may be disabled */ }
  }
}

async function fetchJsonQuiet<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {signal:AbortSignal.timeout(12000)});
      if(response.status===401){window.location.reload();return null;}
      if (!response.ok) return null;
      return await response.json() as T;
    } catch {
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return null;
}

const snapshotRequests = new Map<string, Promise<ScanPayload>>();

function fetchSnapshotPayload(mode: ScreenerMode, sector: string) {
  const key = `${mode}:${sector}`;
  const running = snapshotRequests.get(key);
  if (running) return running;
  const query = new URLSearchParams({ mode, sector });
  const request = beforeDeadline(() => fetch(`/api/scan?${query.toString()}`, {signal:AbortSignal.timeout(15000)}), Date.now() + 15000)
    .then(async (response) => {
      const data: ScanPayload = await response.json();
      if (!response.ok) throw new Error("Cached scan unavailable");
      return data;
    })
    .finally(() => snapshotRequests.delete(key));
  snapshotRequests.set(key, request);
  return request;
}

const MODES: ModeConfig[] = [
  { key: "intraday",       label: "Intraday",    icon: <Activity size={12} />,   desc: "Same-day VWAP momentum plays" },
  { key: "btst",           label: "BTST",        icon: <Clock size={12} />,      desc: "Buy Today Sell Tomorrow" },
  { key: "swing_breakout", label: "Swing BO",    icon: <TrendingUp size={12} />, desc: "Resistance breakout stocks" },
  { key: "swing_pullback", label: "Swing PB",    icon: <BarChart2 size={12} />,  desc: "EMA pullback entries" },
  { key: "positional",     label: "Positional",  icon: <Target size={12} />,     desc: "Weeks-long techno-funda plays" },
  { key: "longterm",       label: "Long-Term",   icon: <Layers size={12} />,     desc: "Long-term quality research" },
];

function formatIST(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value));
}

function Dashboard() {
  const [clockNow, setClockNow] = useState(0);
  useEffect(() => { const tick=()=>setClockNow(Date.now()); tick(); const timer=window.setInterval(tick,30000); return ()=>window.clearInterval(timer); }, []);
  const [refreshError, setScanError] = useState<string|null>(null);
  const [snapshotError, setSnapshotError] = useState<string|null>(null);
  const scanError = snapshotError ?? refreshError;
  const [scanNotice, setScanNotice] = useState<string|null>(null);
  const [scanStatus, setScanStatus] = useState<ScanPayload['status']>();
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const snapshotShown = useRef(false);
  const snapshotStamp = useRef<string | undefined>(undefined);
  const scanRequestOrder = useRef(0);
  const appliedSnapshots = useRef(new Map<ScreenerMode, { revision: number; requestOrder: number }>());
  const [scanPermissions, setScanPermissions] = useState(() => new Map<string, ScanPermission>());
  const refreshControllers = useRef(new Map<string, AbortController>());
  const refreshCooldown = useRef(new Map<string, number>());
  const [coverage, setCoverage] = useState<ScanPayload['coverage']>();
  const [mobilePanel, setMobilePanel] = useState<'results'|'detail'>('results');
  const [ledgerError, setLedgerError] = useState<string|null>(null);
  const [paperSaved, setPaperSaved] = useState(false);
  const scanGeneration = useRef(0), searchGeneration = useRef(0), prefetchGeneration = useRef(0);
  const [marketMood, setMarketMood]     = useState<MarketMood | null>(null);
  const [topSectors, setTopSectors]     = useState<SectorStrength[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [ledgerInsights, setLedgerInsights] = useState<LedgerInsights | null>(null);
  const [selectedMode, setSelectedMode] = useState<ScreenerMode>("swing_breakout");
  const [selectedSector, setSelectedSector] = useState("All");
  const [sectorOpen, setSectorOpen]     = useState(false);
  const [stocks, setStocks]             = useState<ScreenedStock[]>([]);
  const [removedToday, setRemovedToday] = useState<RemovedScanStock[]>([]);
  const [snapshotMeta, setSnapshotMeta] = useState<{ generatedAt: string; expiresAt: string; cached: boolean } | null>(null);
  const [scanLoading, setScanLoading]   = useState(false);
  const [refreshing, setRefreshing]     = useState(false);
  const [selectedStock, setSelectedStock] = useState<ScreenedStock | null>(null);
  const selectedStockRef = useRef<ScreenedStock | null>(null);
  const showStock = useCallback((stock: ScreenedStock | null) => {
    selectedStockRef.current = stock;
    setSelectedStock(stock);
  }, []);
  const [chartLoading, setChartLoading] = useState(false);
  const [analysis, setAnalysis]         = useState<AIAnalysisResult | null>(null);
  const [analysisMeta, setAnalysisMeta] = useState<AnalysisMeta | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<AnalysisFailure | null>(null);
  const [watchlistSaved, setWatchlistSaved] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const refreshInFlight = useRef(new Set<string>());
  const snapshotInFlight = useRef(new Set<string>());
  const marketRegimeRef = useRef<MarketMood["regime"]>("NEUTRAL");
  const analysisController = useRef<AbortController | null>(null);
  const analysisRequestId = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    marketRegimeRef.current = marketMood?.regime ?? "NEUTRAL";
  }, [marketMood?.regime]);

  useEffect(() => {
    void fetchJsonQuiet<MarketMood>('/api/market-mood').then(m=>{if(m)setMarketMood(m);setMarketLoading(false);});
    void fetchJsonQuiet<{topSectors?:SectorStrength[]}>('/api/sector-strength').then(d=>{if(d?.topSectors)setTopSectors(d.topSectors);});
    void fetchJsonQuiet<{stats?:LedgerInsights}>('/api/ledger').then(d=>{if(d?.stats)setLedgerInsights(d.stats);else setLedgerError('Paper ledger unavailable');});
  }, []);

  // Keep LIVE/PRE-OPEN/CLOSED accurate when the tab stays open across a
  // session boundary; the server remains the source of truth in IST.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchJsonQuiet<MarketMood>("/api/market-mood").then((market) => {
        if (market) setMarketMood(market);
      });
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const prefetchTopAnalyses = useCallback((nextStocks: ScreenedStock[]) => {
    if(!clientAIConfigured()) return;
    const generation = ++prefetchGeneration.current, regime = marketRegimeRef.current;
    void (async()=>{
      for(const stock of nextStocks.filter(s=>!s.nearMiss&&!s.dataQuality?.stale).slice(0,3)){
        if(generation!==prefetchGeneration.current)return;
        if(readBrowserAnalysis(stock,regime))continue;
        try {
          const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:stock.symbol,mode:stock.mode}),signal:AbortSignal.timeout(45000)});
          if(!response.ok)return; // Never loop through a provider outage or quota error.
          const data=await response.json();
          if(data.analysis&&data.stock&&data.fingerprint)writeBrowserAnalysis(data.stock,regime,{analysis:data.analysis,stock:data.stock,cachedAt:data.cachedAt,expiresAt:data.expiresAt,cachedCmp:data.cachedCmp,fingerprint:data.fingerprint});
        }catch{return;}
      }
    })();
  }, []);

  const applyScanPayload = useCallback((data: ScanPayload, mode: ScreenerMode, requestOrder: number) => {
    if (!Array.isArray(data.stocks)) return false;
    const cards = data.stocks;
    const removed = Array.isArray(data.removedToday) ? data.removedToday : [];
    const revision = Date.parse(data.updatedAt ?? data.generatedAt ?? '') || 0;
    const previous = appliedSnapshots.current.get(mode);
    const newerRevision = !previous || revision > previous.revision;
    if (previous && (revision < previous.revision ||
        (!newerRevision && requestOrder < previous.requestOrder))) return false;
    appliedSnapshots.current.set(mode, { revision, requestOrder });
    // A partial or sector-filtered scan only speaks for the symbols it includes.
    if (cards.length || removed.length) setScanPermissions(previousPermissions => {
      const permissions = new Map(previousPermissions);
      const update = (symbol: string, nearMiss: boolean, riskPercent: number, reasons: string[]) => {
        const key = permissionKey(mode, symbol);
        const existing = permissions.get(key);
        // A cached read can tighten an existing revision as its evidence expires.
        // Only a newer revision can lift a restriction.
        if (existing?.revision === revision) {
          permissions.set(key, {
            revision,
            nearMiss: existing.nearMiss || nearMiss,
            riskPercent: Math.min(existing.riskPercent, riskPercent),
            reasons: [...new Set([...existing.reasons, ...reasons])]
          });
        } else {
          permissions.set(key, { revision, nearMiss, riskPercent, reasons });
        }
      };
      for (const card of cards) {
        if (card.mode === mode) update(card.symbol, Boolean(card.nearMiss), card.nearMiss ? 0 : (card.positionRiskPercent ?? 0), card.guardReasons ?? []);
      }
      for (const item of removed) update(item.symbol, true, 0, [item.reason]);
      return permissions;
    });
    setStocks(cards);
    const current = selectedStockRef.current;
    const updated = current && cards.find(stock => stock.symbol === current.symbol && stock.mode === current.mode);
    if (current && updated) {
      const evidenceDelta = evidenceTime(updated) - evidenceTime(current);
      const setupChanged = guardFingerprint(updated) !== guardFingerprint(current) ||
        priceMovedBeyondCache(current.mode, current.cmp, updated.cmp);
      if (setupChanged && (evidenceDelta > 0 || (evidenceDelta === 0 && newerRevision))) {
        const sameCandles = updated.dataQuality?.candleAt &&
          updated.dataQuality.candleAt === current.dataQuality?.candleAt &&
          updated.dataQuality.candleSource === current.dataQuality?.candleSource;
        showStock({ ...updated, candles: updated.candles.length || !sameCandles ? updated.candles : current.candles });
        ++analysisRequestId.current;
        setChartLoading(false);
        setAnalysisLoading(false);
        setPaperSaved(false);
        setAnalysis(null);
        setAnalysisMeta(null);
        setAnalysisError({ message: 'Setup updated. Refresh the explanation using current data.' });
      }
    }
    setCoverage(data.coverage);
    setSnapshotLoaded(true); snapshotShown.current = true;
    const isNewSnapshot = Boolean(data.generatedAt && data.generatedAt !== snapshotStamp.current);
    snapshotStamp.current = data.generatedAt;
    setScanStatus(data.status);
    setRemovedToday(removed);
    if (data.generatedAt && data.expiresAt) {
      setSnapshotMeta({ generatedAt: data.generatedAt, expiresAt: data.expiresAt, cached: Boolean(data.cached) });
    }
    if (isNewSnapshot) prefetchTopAnalyses(data.stocks);
    return true;
  }, [prefetchTopAnalyses, showStock]);

  const refreshInBackground = useCallback(async () => {
    const generation = scanGeneration.current;
    const refreshKey = `${selectedMode}:${selectedSector}`;
    if (refreshInFlight.current.has(refreshKey)) return;
    if (Date.now() < (refreshCooldown.current.get(refreshKey) ?? 0)) return;
    const requestOrder = ++scanRequestOrder.current;
    const controller = new AbortController();
    refreshControllers.current.set(refreshKey, controller);
    refreshInFlight.current.add(refreshKey);
    setRefreshing(true); setScanError(null);
    setScanNotice(snapshotShown.current ? 'Refreshing this strategy. Saved results remain visible.' : 'Starting the first scan for this strategy.');
    try {
      const res = await beforeDeadline(() => fetch('/api/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: selectedMode, sector: selectedSector }), signal: controller.signal,
      }).then(async response => ({ response, data: await response.json() })), Date.now() + 55000, controller.signal);
      if (generation !== scanGeneration.current) return;
      const { response, data } = res;
      if (response.ok) {
        if (!applyScanPayload(data, selectedMode, requestOrder)) return;
        setScanNotice(data.message ?? null);
        if (data.expiresAt) refreshCooldown.current.set(refreshKey, Date.parse(data.expiresAt));
      } else {
        const seconds = Number(response.headers.get('Retry-After')) || (response.status === 409 ? 15 : 300);
        refreshCooldown.current.set(refreshKey, Date.now() + Math.max(5, seconds) * 1000);
        if (response.status === 409) setScanNotice('Another scan is running. Saved results stay visible; checking for updates.');
        else { setScanNotice(null); setScanError(data.error ?? 'Refresh unavailable. Saved results are retained.'); }
      }
    } catch (error) {
      if (generation === scanGeneration.current) {
        refreshCooldown.current.set(refreshKey, Date.now() + 60000);
        setScanNotice(null);
        setScanError(error instanceof Error && error.name === 'TimeoutError' ? 'Scan timed out. Saved results are retained. Retry in a minute.' : 'Scan could not complete. Saved results are retained. Retry in a minute.');
      }
    } finally {
      controller.abort();
      if (refreshControllers.current.get(refreshKey) === controller) {
        refreshControllers.current.delete(refreshKey); refreshInFlight.current.delete(refreshKey);
      }
      if (generation === scanGeneration.current) setRefreshing(false);
    }
  }, [applyScanPayload, selectedMode, selectedSector]);

  const loadSnapshot = useCallback(async () => {
    const generation = scanGeneration.current;
    const snapshotKey = `${generation}:${selectedMode}:${selectedSector}`;
    if (snapshotInFlight.current.has(snapshotKey)) return;
    const requestOrder = ++scanRequestOrder.current;
    snapshotInFlight.current.add(snapshotKey);
    setScanLoading(!snapshotShown.current);
    try {
      const data = await fetchSnapshotPayload(selectedMode, selectedSector);
      if (generation !== scanGeneration.current) return;
      setSnapshotError(null);
      const changed = Boolean(data.generatedAt && data.generatedAt !== snapshotStamp.current);
      if (!applyScanPayload(data, selectedMode, requestOrder)) return;
      if (data.message) setScanNotice(data.message);
      if (changed && !data.stale && !refreshInFlight.current.has(`${selectedMode}:${selectedSector}`)) {
        setScanError(null); setScanNotice(data.message ?? null);
      }
      if (data.needsRefresh || data.stale) void refreshInBackground();
    } catch {
      if (generation === scanGeneration.current) setSnapshotError('Could not load the scan snapshot. Saved results are retained; retry refresh.');
    } finally {
      snapshotInFlight.current.delete(snapshotKey);
      if (generation === scanGeneration.current) setScanLoading(false);
    }
  }, [applyScanPayload, refreshInBackground, selectedMode, selectedSector]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadSnapshot(); }, 0);
    const poll = window.setInterval(() => { if (!document.hidden) void loadSnapshot(); }, 15000);
    const visible = () => { if (!document.hidden) void loadSnapshot(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); document.removeEventListener('visibilitychange', visible); };
  }, [loadSnapshot]);

  useEffect(() => {
    const controllers = refreshControllers.current;
    return () => { for (const controller of controllers.values()) controller.abort(); };
  }, []);

  const changeContext = (mode: ScreenerMode, sector = selectedSector) => {
    ++scanGeneration.current; ++searchGeneration.current; ++prefetchGeneration.current; ++analysisRequestId.current;
    for (const controller of refreshControllers.current.values()) controller.abort();
    refreshControllers.current.clear(); refreshInFlight.current.clear();
    snapshotShown.current = false; snapshotStamp.current = undefined; setSnapshotLoaded(false); setScanLoading(false); setRefreshing(false);
    setScanError(null); setSnapshotError(null); setScanNotice(null); setScanStatus(undefined);
    analysisController.current?.abort();
    setChartLoading(false);
    setSelectedMode(mode); setSelectedSector(sector); showStock(null); setAnalysis(null); setAnalysisMeta(null); setAnalysisError(null); setAnalysisLoading(false); setStocks([]); setRemovedToday([]); setSnapshotMeta(null); setCoverage(undefined); setMobilePanel('results'); setSearchError(null);
  };
  const runScan = () => { void refreshInBackground(); };

  const handleSelectStock = useCallback(async (stock: ScreenedStock, forceRefresh = false) => {
    analysisController.current?.abort();
    const requestId = ++analysisRequestId.current;
    const regime = marketRegimeRef.current;
    showStock(stock);setMobilePanel("detail");setPaperSaved(false);
    setAnalysis(null);
    setAnalysisMeta(null);
    setAnalysisError(null);
    setWatchlistSaved(false);
    setChartLoading(false);
    setAnalysisLoading(true);
    try {
      if (!forceRefresh) {
        const browserCached = readBrowserAnalysis(stock, regime);
        if (browserCached) {
          setAnalysis(browserCached.analysis);
          if (!stock.candles.length) showStock({ ...stock, candles: browserCached.stock.candles });
          setAnalysisMeta({ cached: true, cachedAt: browserCached.cachedAt, expiresAt: browserCached.expiresAt });
          setAnalysisLoading(false);
          return;
        }
      }
      const controller = new AbortController();
      analysisController.current = controller;
      let currentStock = stock;
      if (!currentStock.candles.length) {
        setChartLoading(true);
        const details = await fetch('/api/stock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: stock.symbol, mode: stock.mode }),
          signal: AbortSignal.any([controller.signal,AbortSignal.timeout(27000)])
        });
        const payload = await details.json();
        if (requestId !== analysisRequestId.current) return;
        if (!details.ok || !payload.stock) {
          setAnalysisError({ message: payload.error ?? 'Could not load the chart and updated quant data.', code: payload.code ?? 'DATA_UNAVAILABLE' });
          return;
        }
        if (selectedStockRef.current && isOlderStock(payload.stock, selectedStockRef.current)) {
          setAnalysisError({ message: 'Setup updated. Refresh the explanation using current data.' });
          return;
        }
        currentStock = payload.stock;
        showStock(currentStock);
        setChartLoading(false);
      }
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol:stock.symbol, mode:stock.mode, forceRefresh }),
        signal: AbortSignal.any([controller.signal,AbortSignal.timeout(55000)]),
      });
      const data = await res.json();
      if (requestId !== analysisRequestId.current) return;
      const latest = selectedStockRef.current;
      if ((data.stock && latest && isOlderStock(data.stock, latest)) ||
          (res.ok && data.analysis && (!data.stock || data.fingerprint !== guardFingerprint(data.stock)))) {
        setAnalysisError({ message: 'Setup updated. Refresh the explanation using current data.' });
        return;
      }
      if (data.stock) showStock(data.stock);
      if (!res.ok || !data.analysis) {
        setAnalysisError({ message: data.error ?? "Analysis failed. Please try again.", code: data.code });
        return;
      }
      setAnalysisError(null);
      setAnalysis(data.analysis);
      if (data.cachedAt && data.expiresAt) {
        setAnalysisMeta({ cached: Boolean(data.cached), cachedAt: data.cachedAt, expiresAt: data.expiresAt });
        writeBrowserAnalysis(data.stock??currentStock, regime, {
          analysis: data.analysis,
          cachedAt: data.cachedAt,
          expiresAt: data.expiresAt,
          cachedCmp: data.cachedCmp,
          fingerprint: data.fingerprint,
          stock: data.stock??currentStock,
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (requestId === analysisRequestId.current) {
        setAnalysisError({message: err instanceof Error ? err.message : "Analysis failed. Please try again."});
      }
    } finally {
      if (requestId === analysisRequestId.current) {
        setAnalysisLoading(false);
        setChartLoading(false);
      }
    }
  }, [showStock]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("dialog[open]")) return;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (typing || stocks.length === 0 || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      event.preventDefault();
      const currentIndex = selectedStock ? stocks.findIndex((stock) => stock.symbol === selectedStock.symbol) : -1;
      const nextIndex = event.key === "ArrowDown"
        ? (currentIndex + 1) % stocks.length
        : (currentIndex <= 0 ? stocks.length - 1 : currentIndex - 1);
      void handleSelectStock(stocks[nextIndex]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSelectStock, selectedStock, stocks]);

  const saveToWatchlist = useCallback(async () => {
    if(!selectedStock)return;
    try{const res=await fetch('/api/watchlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:selectedStock.symbol,mode:selectedStock.mode,alertEnabled:true})});const data=await res.json();if(!res.ok)throw new Error(data.error);setWatchlistSaved(true);}catch(e){setSearchError(e instanceof Error?e.message:'Watchlist unavailable');}
  },[selectedStock]);
  const trackPaper = async()=>{
    if(!selectedStock)return;
    try{const r=await fetch('/api/ledger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:selectedStock.symbol,mode:selectedStock.mode})});const data=await r.json();if(!r.ok)throw new Error(data.error);setPaperSaved(true);}catch(e){setLedgerError(e instanceof Error?e.message:'Paper tracking unavailable');}
  };

  const handleSearch = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    const generation=++searchGeneration.current;
    const detailRequest = analysisRequestId.current;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: searchQuery, mode: selectedMode }),
      });
      const data: {stock?: ScreenedStock; error?: string} = await res.json();
      if (!res.ok || !data.stock) throw new Error(data.error ?? "Stock lookup failed");
      if(generation!==searchGeneration.current)return;
      const stock = data.stock;
      const current = selectedStockRef.current;
      if (current && current.symbol === stock.symbol && current.mode === stock.mode &&
          (detailRequest !== analysisRequestId.current || isOlderStock(stock, current))) {
        throw new Error('Setup updated. Search again using current data.');
      }
      setStocks((current) => [stock, ...current.filter((item) => item.symbol !== stock.symbol)]);
      await handleSelectStock(stock);
    } catch (error) {
      if(generation===searchGeneration.current)setSearchError(error instanceof Error ? error.message : "Stock lookup failed");
    } finally {
      if(generation===searchGeneration.current)setSearchLoading(false);
    }
  }, [handleSelectStock, searchQuery, selectedMode]);

  const withEffectivePermission = useCallback((stock: ScreenedStock) => {
    const permission = scanPermissions.get(permissionKey(stock.mode, stock.symbol));
    return withMarketPermission(withScanPermission(stock, permission), marketMood);
  }, [scanPermissions, marketMood]);
  const visibleStocks = useMemo(() => stocks.map(withEffectivePermission), [stocks, withEffectivePermission]);
  const detailStock = useMemo(() => {
    if (!selectedStock) return null;
    const permitted = withEffectivePermission(selectedStock);
    const source = selectedStock.dataQuality;
    const current = source && !source.stale && clockNow > 0
      ? recheckDataQuality(source, selectedStock.mode === 'intraday', new Date(clockNow))
      : source;
    const newlyStale = current?.stale && !source?.stale;
    const shortHorizon=selectedStock.mode==='intraday'||selectedStock.mode==='btst';
    const now = new Date(clockNow);
    const cas = selectedStock.tickSizeAsOf === dateToISTString(now) ? selectedStock.casEligible ?? null : null;
    const sessionEnded=shortHorizon&&clockNow>0&&getMarketSession(now,cas).state!=='LIVE';
    const detailsPending=!selectedStock.candles.length;
    const referenceReasons = clockNow > 0 ? referenceEntryReasons(selectedStock, now) : [];
    if (!newlyStale && !sessionEnded && !detailsPending && !referenceReasons.length) return permitted;
    return {
      ...permitted,
      nearMiss: true,
      positionRiskPercent: 0,
      researchQualified: !newlyStale&&selectedStock.researchQualified,
      dataQuality: current,
      guardReasons: [...new Set([
        ...(permitted.guardReasons ?? []),
        ...referenceReasons,
        ...(newlyStale ? current.issues : []),
        ...(sessionEnded ? ['Continuous trading session is not confirmed open'] : []),
        ...(detailsPending ? ['Full stock history has not loaded'] : [])
      ])]
    };
  }, [selectedStock, clockNow, withEffectivePermission]);

  const expiredExplanation = Boolean(analysis && (detailStock?.dataQuality?.stale ||
    (analysisMeta && clockNow >= Date.parse(analysisMeta.expiresAt))));
  const visibleAnalysis = expiredExplanation ? null : analysis;
  const dataPaused = analysisError?.code === 'STALE_DATA' || analysisError?.code === 'DATA_UNAVAILABLE' ||
    analysisError?.code === 'INSUFFICIENT_HISTORY';
  const budgetPaused = analysisError?.code === 'AI_DAILY_LIMIT';

  const qualifiedCount = visibleStocks.filter(qualifiesForShortlist).length;
  const nearMissCount = stocks.length - qualifiedCount;
  const selectedPlan = selectedStock?.candles.length ? getTradePlan(selectedStock) : null;
  const canTrackPaper = selectedPlan?.accepted && Date.parse(selectedPlan.validUntil) > clockNow &&
    !detailStock?.nearMiss && (detailStock?.positionRiskPercent ?? 0) > 0;

  return (
    <div className="h-dvh flex flex-col overflow-hidden" style={{ background: "var(--bg-base)" }}>

      {/* ── Header ── */}
      <header className="flex-shrink-0 border-b border-slate-800/60 px-4 py-2.5"
        style={{ background: "rgba(4,7,15,0.95)", backdropFilter: "blur(12px)" }}>
        <div className="flex items-center gap-4 flex-wrap">

          {/* Logo */}
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-emerald-600 flex items-center justify-center">
              <span className="text-slate-950 font-black text-xs">DS</span>
            </div>
            <div>
              <div className="font-black text-sm text-white leading-none">
                Deep<span className="text-cyan-400">Stocks</span>
              </div>
              <div className="text-[9px] text-slate-600 uppercase tracking-wider leading-none mt-0.5">
                NSE · Research Screener
              </div>
            </div>
          </div>

          {/* Market Regime */}
          <PortfolioDesk />
          <div className="flex-1">
            <MarketRegimeBadge
              available={marketMood?.available}
              regime={marketMood?.regime ?? null}
              niftyClose={marketMood?.niftyClose ?? null}
              ema20={marketMood?.ema20 ?? null}
              ema50={marketMood?.ema50 ?? null}
              indiaVix={marketMood?.indiaVix}
              defensiveMode={marketMood?.defensiveMode}
              riskMultiplier={marketMood?.riskMultiplier}
              regimeReason={marketMood?.regimeReason}
              message={marketMood?.message ?? null}
              loading={marketLoading}
              topSectors={topSectors}
              session={marketMood?.session}
            />
          </div>

          {/* Scan count */}
          {stocks.length > 0 && (
            <div className="text-xs font-mono text-slate-500 hidden md:block">
              <span className="text-cyan-400 font-bold">{qualifiedCount}</span> {selectedMode==='longterm'?'research candidates':'found'}
              {nearMissCount > 0 && <span className="text-amber-500 ml-1">· ~{nearMissCount} near</span>}
              {removedToday.length > 0 && <span className="text-slate-600 ml-1">· {removedToday.length} removed</span>}
            </div>
          )}
        </div>
      </header>

      {marketMood?.available === false ? (
        <div className="flex-shrink-0 border-b border-amber-900/50 bg-amber-950/60 px-4 py-1.5 text-center text-xs text-amber-200">
          <strong>Market data unverified.</strong> Nifty or India VIX data is stale or unavailable. New-entry sizing is paused until the data is verified.
        </div>
      ) : (marketMood?.regime === "BEARISH" || marketMood?.defensiveMode) && (
        <div className="flex-shrink-0 border-b border-red-900/50 bg-red-950/60 px-4 py-1.5 text-center text-xs text-red-300">
          <strong>Defensive Mode.</strong> {marketMood.regimeReason ?? "Index trend or India VIX indicates elevated risk."} New entries use reduced risk limits.
        </div>
      )}

      {ledgerInsights && ledgerInsights.closed > 0 && (
        <div className="flex-shrink-0 border-b border-slate-800/50 bg-slate-950/70 px-4 py-1.5 text-[10px] font-mono text-slate-500">
          Ledger: <span className="text-cyan-300">{ledgerInsights.winRate == null ? "—" : `${(ledgerInsights.winRate * 100).toFixed(0)}%`} win rate</span>
          {ledgerInsights.byRvol?.high.closed ? <> · RVOL ≥1.8: <span className="text-emerald-300">{ledgerInsights.byRvol.high.winRate == null ? "—" : `${(ledgerInsights.byRvol.high.winRate * 100).toFixed(0)}%`}</span></> : null}
          {ledgerInsights.byRvol?.low.closed ? <> · RVOL &lt;1.8: <span className="text-amber-300">{ledgerInsights.byRvol.low.winRate == null ? "—" : `${(ledgerInsights.byRvol.low.winRate * 100).toFixed(0)}%`}</span></> : null}
        </div>
      )}

      {/* ── Controls Bar ── */}
      <div className="flex-shrink-0 border-b border-slate-800/50 px-4 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: "rgba(4,7,15,0.90)" }}>

        <form onSubmit={handleSearch} className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1">
          <Search size={13} className="text-slate-500" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value.toUpperCase())}
            placeholder="NSE symbol"
            aria-label="Search NSE symbol"
            className="w-24 bg-transparent text-xs text-slate-200 outline-none placeholder:text-slate-600"
          />
          <button type="submit" disabled={searchLoading} className="text-[10px] font-semibold text-cyan-400 disabled:text-slate-600">
            {searchLoading ? "…" : "Deep dive"}
          </button>
        </form>
        {searchError && <span className="text-[10px] text-red-400">{searchError}</span>}

        {/* Mode tabs */}
        <div className="flex gap-1 flex-wrap">
          {MODES.map((m) => {
            const active = selectedMode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => changeContext(m.key)}
                title={m.desc}
                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-all ${
                  active
                    ? "bg-cyan-950/60 border-cyan-600 text-cyan-300"
                    : "border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300"
                }`}
              >
                {m.icon}
                {m.label}
              </button>
            );
          })}
        </div>

        {/* Sector dropdown */}
        <div className="relative">
          <button
            onClick={() => setSectorOpen(!sectorOpen)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-800 text-xs text-slate-400 hover:border-slate-700 hover:text-slate-200 transition-all"
          >
            {selectedSector === "All" ? "All Sectors" : selectedSector}
            <ChevronDown size={10} className={`transition-transform ${sectorOpen ? "rotate-180" : ""}`} />
          </button>
          {sectorOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setSectorOpen(false)} />
              <div className="absolute top-9 left-0 z-30 w-52 rounded-xl border border-slate-800 overflow-hidden shadow-2xl"
                style={{ background: "rgba(8,14,26,0.98)" }}>
                <div className="p-1 max-h-56 overflow-y-auto">
                  {["All", ...SECTORS].map((s) => (
                    <button
                      key={s}
                      onClick={() => { changeContext(selectedMode,s); setSectorOpen(false); }}
                      className={`w-full text-left text-xs px-3 py-1.5 rounded-lg transition-all ${
                        selectedSector === s
                          ? "bg-cyan-950/60 text-cyan-400"
                          : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Scan button */}
        <button
          onClick={runScan}
          disabled={scanLoading || refreshing}
          className={`ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-bold border transition-all ${
            scanLoading
              ? "border-slate-700 text-slate-500 cursor-not-allowed"
              : "border-cyan-700 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-900/40"
          }`}
        >
          {(scanLoading || refreshing)
            ? <><RefreshCw size={11} className="animate-spin" /> {scanLoading ? "Loading snapshot..." : "Scanning..."}</>
            : <><Zap size={11} /> Scan {MODES.find(m => m.key === selectedMode)?.label}</>
          }
        </button>
        {snapshotMeta && (
          <span className="text-[10px] font-mono text-slate-600 hidden lg:inline-flex items-center gap-1">
            {refreshing ? <RefreshCw size={10} className="animate-spin text-cyan-500" /> : "●"}
            {snapshotMeta.cached ? "Cached" : "Snapshot"} {formatIST(snapshotMeta.generatedAt)} IST
          </span>
        )}
      </div>

      <div className="flex-shrink-0 border-b border-slate-800 px-4 py-1.5 text-[11px] text-slate-400">
        {coverage&&<span>Coverage {coverage.processed}/{coverage.requested}{coverage.verified!=null&&` · ${coverage.verified} data-verified when scanned`}{coverage.failed.length>0&&` · ${coverage.failed.length} unavailable`}{Boolean(coverage.deferred?.length)&&` · ${coverage.deferred!.length} pending`}. </span>}
        {snapshotMeta&&<span>Snapshot {new Date(snapshotMeta.generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST{Date.parse(snapshotMeta.expiresAt)<clockNow?' · refresh due':''}. </span>}
        Delayed market research; verify execution quotes.
        {scanNotice&&<p role="status" className="text-cyan-300">{scanNotice}</p>}
        {(scanError||ledgerError)&&<p role="alert" className="text-amber-300">{scanError||ledgerError}</p>}
        <OperationsStatus />
      </div>
      <div className="flex md:hidden gap-2 px-3 py-2 border-b border-slate-800"><button onClick={()=>setMobilePanel('results')} className="rounded border border-slate-700 px-3 py-1 text-xs">Results</button><button onClick={()=>setMobilePanel('detail')} disabled={!selectedStock} className="rounded border border-slate-700 px-3 py-1 text-xs disabled:opacity-40">Stock details</button></div>
      {/* ── Main 3-pane layout ── */}
      <main className="flex-1 flex gap-0 overflow-hidden min-h-0">

        {/* Col 1: Stock List */}
        <div className={`${mobilePanel==='results'?'flex':'hidden'} md:flex w-full md:w-[270px] flex-shrink-0 flex-col border-r border-slate-800/50`}
          style={{ background: "var(--bg-panel)" }}>
          <div className="px-3 py-2 border-b border-slate-800/40 flex items-center justify-between flex-shrink-0">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Results</span>
            {stocks.length > 0 && (
              <div className="flex gap-1">
                <span className="text-[10px] font-mono text-cyan-400 bg-cyan-950/50 border border-cyan-900/50 px-1.5 py-0.5 rounded-full">{qualifiedCount}</span>
                {nearMissCount > 0 && <span className="text-[10px] font-mono text-amber-500 bg-amber-950/40 border border-amber-900/40 px-1.5 py-0.5 rounded-full">~{nearMissCount}</span>}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <StockList
              stocks={visibleStocks}
              removedToday={removedToday}
              selected={selectedStock}
              onSelect={stock => {
                const research = stocks.find(item => item.symbol === stock.symbol && item.mode === stock.mode);
                if (research) void handleSelectStock(research);
              }}
              loading={scanLoading}
              emptyTitle={scanError || scanStatus === 'unavailable' ? 'Scan unavailable' : refreshing ? 'Scanning this strategy' : scanStatus==='partial' ? 'Partial scan' : snapshotLoaded ? 'No matching setups' : 'No scan data yet'}
              emptyMessage={scanError ?? scanNotice ?? (scanStatus === 'partial' ? 'This scan is incomplete. Pending symbols will be checked in the next batch.' : snapshotLoaded ? 'No setups matched the selected strategy and sector in the available data.' : 'Load a saved snapshot or start a scan.')}
            />
          </div>
        </div>

        {/* Col 2+3: Chart + AI report stacked */}
        <div className={`${mobilePanel==='detail'?'flex':'hidden'} md:flex flex-1 flex-col overflow-y-auto md:overflow-hidden min-w-0 min-h-0`}>

          {/* Chart */}
          <div className="h-[240px] md:h-[300px] flex-shrink-0 border-b border-slate-800/50 flex flex-col"
            style={{ background: "var(--bg-panel)" }}>
            <div className="px-3 py-2 border-b border-slate-800/40 flex items-center gap-2 flex-shrink-0">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
                {selectedStock ? selectedStock.symbol.replace(".NS", "") + " — Chart" : "Price Chart"}
              </span>
              {selectedStock && (
                <div className="ml-auto flex flex-wrap items-center gap-2 text-[10px] font-mono">
                  <span className="text-slate-500">ATR <span className="text-amber-400">{selectedStock.atr.toFixed(2)}</span></span>
                  {selectedStock.mode==='intraday'&&<span className="text-slate-500">VWAP <span className="text-cyan-400">₹{selectedStock.vwap.toFixed(2)}</span></span>}
                  <span className={`font-bold ${selectedStock.dayChangePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {selectedStock.dayChangePercent >= 0 ? "▲" : "▼"}{Math.abs(selectedStock.dayChangePercent).toFixed(2)}%
                  </span>
                  <button onClick={()=>void trackPaper()} disabled={!canTrackPaper||paperSaved} className="rounded border border-slate-700 px-2 py-1 text-[10px] disabled:opacity-40">{paperSaved?'Paper tracked':'Track paper'}</button>
                  <button
                    onClick={saveToWatchlist}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 transition hover:border-cyan-700 hover:text-cyan-300"
                  >
                    {watchlistSaved ? "Saved" : "Save"}
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 relative grid-bg" aria-busy={chartLoading}>
              {chartLoading && <div role="status" className="absolute inset-0 z-10 grid place-items-center bg-slate-950/80 text-xs text-cyan-300">Loading stock candles…</div>}
              <CandlestickChart
                candles={selectedStock?.candles ?? []}
                interval={selectedStock?.mode === 'intraday' ? '15m' : '1d'}
                ema20={selectedStock?.ema20 ?? 0}
                ema50={selectedStock?.ema50 ?? 0}
                ema200={selectedStock?.ema200 ?? 0}
                symbol={selectedStock?.symbol ?? ""}
              entryPrice={selectedPlan?.entry}
              stopLoss={selectedPlan?.stopLoss}
              target1={selectedPlan?.target1}
              target2={selectedPlan?.target2}
              />
            </div>
          </div>

          {/* AI Report */}
          <div className="flex-none md:flex-1 overflow-visible md:overflow-hidden flex flex-col min-h-0" style={{ background: "var(--bg-panel)" }}>
            <div className="px-3 py-2 border-b border-slate-800/40 flex items-center gap-2 flex-shrink-0">
              <div className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-black"
                style={{ background: "linear-gradient(135deg,#a855f7,#06b6d4)" }}>AI</div>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Research explanation</span>
              {analysis && visibleAnalysis && !analysisLoading && !detailStock?.nearMiss && (
                <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded border ${
                  analysis.verdictBadge === "STRONG BUY SETUP"  ? "bg-emerald-950/50 border-emerald-800 text-emerald-400" :
                  analysis.verdictBadge === "BUY ON DIP"        ? "bg-cyan-950/50 border-cyan-800 text-cyan-400" :
                  analysis.verdictBadge === "WATCHLIST ONLY"    ? "bg-amber-950/50 border-amber-800 text-amber-400" :
                  "bg-red-950/50 border-red-800 text-red-400"
                }`}>{analysis.verdictBadge}</span>
              )}
            </div>
            <div className="md:flex-1 md:overflow-y-auto">
              {(analysisError || expiredExplanation) && !analysisLoading && (
                <div role="status" className={"m-4 rounded-xl border p-4 text-sm " + (dataPaused || budgetPaused || expiredExplanation ? 'border-amber-900/60 bg-amber-950/30 text-amber-200' : 'border-red-900/60 bg-red-950/30 text-red-300')}>
                  <div className="font-semibold">{dataPaused ? 'AI paused · stock data incomplete' : budgetPaused ? 'Daily AI limit reached' : expiredExplanation ? 'AI explanation expired' : 'AI analysis unavailable'}</div>
                  <p className="mt-1 text-xs">{analysisError?.message ?? 'Refresh analysis to use current data. The chart and quant research are below.'}</p>
                  {selectedStock && (
                    <button
                      onClick={() => handleSelectStock(selectedStock)}
                      className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-semibold transition hover:bg-white/5"
                    >
                      {dataPaused ? 'Recheck stock data' : 'Retry analysis'}
                    </button>
                  )}
                </div>
              )}
                <AIReportCard
                  analysis={visibleAnalysis}
                  stock={detailStock}
                  loading={analysisLoading}
                  analysisMeta={visibleAnalysis ? analysisMeta : null}
                  onRefresh={selectedStock ? () => { void handleSelectStock(selectedStock, true); } : undefined}
                />
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="flex-shrink-0 border-t border-slate-900 py-1 px-4 text-center"
        style={{ background: "rgba(4,7,15,0.9)" }}>
        <p className="text-[10px] text-slate-700">
          DeepStocks · NSE Quant Screener · Quant research · Optional AI explanation · Educational use only · Not SEBI-registered advice
        </p>
      </footer>
    </div>
  );
}

export default function Home(){return <AccessGate><Dashboard/></AccessGate>;}

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, TrendingUp, Activity, BarChart2, Target, Clock,
  Zap, ChevronDown, Layers, Search
} from "lucide-react";
import MarketRegimeBadge, { type SectorStrength } from "@/components/MarketRegimeBadge";
import StockList from "@/components/StockList";
import dynamic from "next/dynamic";
import AIReportCard from "@/components/AIReportCard";
import { ScreenedStock, ScreenerMode } from "@/lib/screenerEngine";
import { AIAnalysisResult } from "@/lib/aiAnalyst";
import { SECTORS } from "@/lib/niftyStocks";

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
  regime: "BULLISH" | "NEUTRAL" | "BEARISH";
  niftyClose: string | null;
  ema20: string | null;
  ema50: string | null;
  message: string | null;
  session?: {
    state: "PRE_OPEN" | "LIVE" | "CLOSED";
    label: "PRE-OPEN" | "LIVE MARKET" | "MARKET CLOSED";
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

const MODES: ModeConfig[] = [
  { key: "intraday",       label: "Intraday",    icon: <Activity size={12} />,   desc: "Same-day VWAP momentum plays" },
  { key: "btst",           label: "BTST",        icon: <Clock size={12} />,      desc: "Buy Today Sell Tomorrow" },
  { key: "swing_breakout", label: "Swing BO",    icon: <TrendingUp size={12} />, desc: "Resistance breakout stocks" },
  { key: "swing_pullback", label: "Swing PB",    icon: <BarChart2 size={12} />,  desc: "EMA pullback entries" },
  { key: "positional",     label: "Positional",  icon: <Target size={12} />,     desc: "Weeks-long techno-funda plays" },
  { key: "longterm",       label: "Long-Term",   icon: <Layers size={12} />,     desc: "1–5 year compounders" },
];

export default function Home() {
  const [marketMood, setMarketMood]     = useState<MarketMood | null>(null);
  const [topSectors, setTopSectors]     = useState<SectorStrength[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [selectedMode, setSelectedMode] = useState<ScreenerMode>("swing_breakout");
  const [selectedSector, setSelectedSector] = useState("All");
  const [sectorOpen, setSectorOpen]     = useState(false);
  const [stocks, setStocks]             = useState<ScreenedStock[]>([]);
  const [scanLoading, setScanLoading]   = useState(false);
  const [selectedStock, setSelectedStock] = useState<ScreenedStock | null>(null);
  const [analysis, setAnalysis]         = useState<AIAnalysisResult | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [watchlistSaved, setWatchlistSaved] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/market-mood")
      .then((r) => r.json())
      .then((data) => setMarketMood(data))
      .catch(console.error)
      .finally(() => setMarketLoading(false));

    fetch("/api/sector-strength")
      .then((r) => r.json())
      .then((data) => { if (data.topSectors) setTopSectors(data.topSectors); })
      .catch(console.error);
  }, []);

  const runScan = useCallback(async () => {
    setScanLoading(true);
    setSelectedStock(null);
    setAnalysis(null);
    setAnalysisError(null);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: selectedMode, sector: selectedSector }),
      });
      const data = await res.json();
      if (data.stocks) setStocks(data.stocks);
    } catch (err) {
      console.error(err);
    } finally {
      setScanLoading(false);
    }
  }, [selectedMode, selectedSector]);

  const handleSelectStock = useCallback(async (stock: ScreenedStock) => {
    setSelectedStock(stock);
    setAnalysis(null);
    setAnalysisError(null);
    setWatchlistSaved(false);
    setAnalysisLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stock, marketRegime: marketMood?.regime ?? "NEUTRAL" }),
      });
      const data = await res.json();
      if (!res.ok || !data.analysis) {
        throw new Error(data.error ?? data.details ?? "Analysis failed. Please try again.");
      }
      setAnalysis(data.analysis);
      void fetch("/api/ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: stock.symbol,
          mode: stock.mode,
          signalDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
          entry: stock.cmp,
          stopLoss: stock.defaultSL,
          target1: stock.target1,
          target2: stock.target2,
          quantScore: stock.quantScore,
        }),
      }).catch(() => undefined);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed. Please try again.");
    } finally {
      setAnalysisLoading(false);
    }
  }, [marketMood]);

  const saveToWatchlist = useCallback(async () => {
    if (!selectedStock) return;
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: selectedStock.symbol,
        zoneLow: Math.max(0, selectedStock.cmp - selectedStock.atr * 0.5),
        zoneHigh: selectedStock.cmp + selectedStock.atr * 0.5,
      }),
    });
    if (res.ok) setWatchlistSaved(true);
  }, [selectedStock]);

  const handleSearch = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: searchQuery, mode: selectedMode }),
      });
      const data = await res.json();
      if (!res.ok || !data.stock) throw new Error(data.error ?? "Stock lookup failed");
      setStocks((current) => [data.stock, ...current.filter((item) => item.symbol !== data.stock.symbol)].slice(0, 10));
      await handleSelectStock(data.stock);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Stock lookup failed");
    } finally {
      setSearchLoading(false);
    }
  }, [handleSelectStock, searchQuery, selectedMode]);

  const qualifiedCount = stocks.filter(s => !s.nearMiss).length;
  const nearMissCount  = stocks.filter(s =>  s.nearMiss).length;

  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: "var(--bg-base)" }}>

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
                NSE · BSE · AI Screener
              </div>
            </div>
          </div>

          {/* Market Regime */}
          <div className="flex-1">
            <MarketRegimeBadge
              regime={marketMood?.regime ?? null}
              niftyClose={marketMood?.niftyClose ?? null}
              ema20={marketMood?.ema20 ?? null}
              ema50={marketMood?.ema50 ?? null}
              message={marketMood?.message ?? null}
              loading={marketLoading}
              topSectors={topSectors}
              session={marketMood?.session}
            />
          </div>

          {/* Scan count */}
          {stocks.length > 0 && (
            <div className="text-xs font-mono text-slate-500 hidden md:block">
              <span className="text-cyan-400 font-bold">{qualifiedCount}</span> found
              {nearMissCount > 0 && <span className="text-amber-500 ml-1">· ~{nearMissCount} near</span>}
            </div>
          )}
        </div>
      </header>

      {/* ── Bearish Banner ── */}
      {marketMood?.regime === "BEARISH" && (
        <div className="flex-shrink-0 bg-red-950/60 border-b border-red-900/50 text-red-300 text-xs py-1.5 px-4 text-center">
          ⚠️ <strong>Bearish Market</strong> — Nifty below EMA50. Use half size, tight stops.
        </div>
      )}

      {/* ── Controls Bar ── */}
      <div className="flex-shrink-0 border-b border-slate-800/50 px-4 py-2 flex items-center gap-2 flex-wrap"
        style={{ background: "rgba(4,7,15,0.90)" }}>

        <form onSubmit={handleSearch} className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950/60 px-2 py-1">
          <Search size={13} className="text-slate-500" />
          <input
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
                onClick={() => setSelectedMode(m.key)}
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
                      onClick={() => { setSelectedSector(s); setSectorOpen(false); }}
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
          disabled={scanLoading}
          className={`ml-auto inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-bold border transition-all ${
            scanLoading
              ? "border-slate-700 text-slate-500 cursor-not-allowed"
              : "border-cyan-700 bg-cyan-950/40 text-cyan-300 hover:bg-cyan-900/40"
          }`}
        >
          {scanLoading
            ? <><RefreshCw size={11} className="animate-spin" /> Scanning...</>
            : <><Zap size={11} /> Scan {MODES.find(m => m.key === selectedMode)?.label}</>
          }
        </button>
      </div>

      {/* ── Main 3-pane layout ── */}
      <main className="flex-1 flex gap-0 overflow-hidden min-h-0">

        {/* Col 1: Stock List */}
        <div className="w-[270px] flex-shrink-0 flex flex-col border-r border-slate-800/50"
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
            <StockList stocks={stocks} selected={selectedStock} onSelect={handleSelectStock} loading={scanLoading} />
          </div>
        </div>

        {/* Col 2+3: Chart + AI report stacked */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Chart */}
          <div className="h-[300px] flex-shrink-0 border-b border-slate-800/50 flex flex-col"
            style={{ background: "var(--bg-panel)" }}>
            <div className="px-3 py-2 border-b border-slate-800/40 flex items-center gap-2 flex-shrink-0">
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
                {selectedStock ? selectedStock.symbol.replace(".NS", "") + " — Chart" : "Price Chart"}
              </span>
              {selectedStock && (
                <div className="ml-auto flex items-center gap-3 text-[11px] font-mono">
                  <span className="text-slate-500">ATR <span className="text-amber-400">{selectedStock.atr.toFixed(1)}</span></span>
                  <span className="text-slate-500">VWAP <span className="text-cyan-400">₹{selectedStock.vwap.toFixed(0)}</span></span>
                  <span className={`font-bold ${selectedStock.dayChangePercent >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {selectedStock.dayChangePercent >= 0 ? "▲" : "▼"}{Math.abs(selectedStock.dayChangePercent).toFixed(2)}%
                  </span>
                  <button
                    onClick={saveToWatchlist}
                    className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-semibold text-slate-300 transition hover:border-cyan-700 hover:text-cyan-300"
                  >
                    {watchlistSaved ? "Saved" : "Save"}
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 relative grid-bg">
              <CandlestickChart
                candles={selectedStock?.candles ?? []}
                ema20={selectedStock?.ema20 ?? 0}
                ema50={selectedStock?.ema50 ?? 0}
                ema200={selectedStock?.ema200 ?? 0}
                symbol={selectedStock?.symbol ?? ""}
              />
            </div>
          </div>

          {/* AI Report */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0" style={{ background: "var(--bg-panel)" }}>
            <div className="px-3 py-2 border-b border-slate-800/40 flex items-center gap-2 flex-shrink-0">
              <div className="w-4 h-4 rounded flex items-center justify-center text-[9px] font-black"
                style={{ background: "linear-gradient(135deg,#a855f7,#06b6d4)" }}>G</div>
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Gemini AI Analysis</span>
              {analysis && !analysisLoading && (
                <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded border ${
                  analysis.verdictBadge === "STRONG BUY SETUP"  ? "bg-emerald-950/50 border-emerald-800 text-emerald-400" :
                  analysis.verdictBadge === "BUY ON DIP"        ? "bg-cyan-950/50 border-cyan-800 text-cyan-400" :
                  analysis.verdictBadge === "WATCHLIST ONLY"    ? "bg-amber-950/50 border-amber-800 text-amber-400" :
                  "bg-red-950/50 border-red-800 text-red-400"
                }`}>{analysis.verdictBadge}</span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">
              {analysisError && !analysisLoading ? (
                <div className="m-4 rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-300">
                  <div className="font-semibold">AI analysis unavailable</div>
                  <p className="mt-1 text-xs text-red-300/80">{analysisError}</p>
                  {selectedStock && (
                    <button
                      onClick={() => handleSelectStock(selectedStock)}
                      className="mt-3 rounded-lg border border-red-800/70 px-3 py-1.5 text-xs font-semibold text-red-200 transition hover:bg-red-900/40"
                    >
                      Retry analysis
                    </button>
                  )}
                </div>
              ) : (
                <AIReportCard analysis={analysis} stock={selectedStock} loading={analysisLoading} />
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="flex-shrink-0 border-t border-slate-900 py-1 px-4 text-center"
        style={{ background: "rgba(4,7,15,0.9)" }}>
        <p className="text-[10px] text-slate-700">
          DeepStocks · NSE/BSE Quant Screener · Powered by Gemini AI · Educational use only · Not SEBI-registered advice
        </p>
      </footer>
    </div>
  );
}

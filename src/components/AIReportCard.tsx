"use client";
import { useState } from "react";
import { AIAnalysisResult } from "@/lib/aiAnalyst";
import { ScreenedStock } from "@/lib/screenerEngine";

interface Props {
  analysis: AIAnalysisResult | null;
  stock: ScreenedStock | null;
  loading: boolean;
}

/* ───────── Conviction Arc Gauge ───────── */
function ConvictionArc({ score }: { score: number }) {
  const radius = 40;
  const circumference = Math.PI * radius; // half circle
  const pct = score / 10;
  const dashOffset = circumference * (1 - pct);
  const color =
    score >= 7 ? "#10b981" :
    score >= 5 ? "#06b6d4" :
    score >= 3 ? "#f59e0b" : "#ef4444";
  const label =
    score >= 8 ? "VERY HIGH" :
    score >= 6 ? "HIGH" :
    score >= 4 ? "MODERATE" : "LOW";

  return (
    <div className="flex items-center gap-4">
      <div className="relative w-24 h-14 flex-shrink-0">
        <svg viewBox="0 0 100 56" className="w-full h-full overflow-visible">
          {/* Track */}
          <path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke="#1e3050"
            strokeWidth="8"
            strokeLinecap="round"
          />
          {/* Fill */}
          <path
            d="M 10 50 A 40 40 0 0 1 90 50"
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            style={{ transition: "stroke-dashoffset 1s ease-out", filter: `drop-shadow(0 0 6px ${color}60)` }}
          />
          {/* Score text */}
          <text x="50" y="46" textAnchor="middle" fill={color} fontSize="16" fontWeight="800" fontFamily="JetBrains Mono, monospace">
            {score}
          </text>
          <text x="50" y="56" textAnchor="middle" fill="#475569" fontSize="7" fontFamily="Inter, sans-serif">
            /10
          </text>
        </svg>
      </div>
      <div>
        <div className="text-xs text-slate-500 uppercase tracking-widest mb-0.5">Conviction</div>
        <div className="font-bold text-sm" style={{ color }}>{label}</div>
        <div className="mt-1 flex gap-1">
          {Array.from({ length: 10 }).map((_, i) => (
            <div
              key={i}
              className="h-1 flex-1 rounded-full transition-all duration-700"
              style={{ background: i < score ? color : "#1e3050" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────── Verdict Badge ───────── */
function VerdictBadge({ verdict }: { verdict: string }) {
  const configs: Record<string, { cls: string; icon: string }> = {
    "STRONG BUY SETUP":  { cls: "verdict-strong-buy",  icon: "🚀" },
    "BUY ON DIP":        { cls: "verdict-buy-dip",     icon: "📉" },
    "WATCHLIST ONLY":    { cls: "verdict-watchlist",   icon: "👁" },
    "AVOID - HIGH RISK": { cls: "verdict-avoid",       icon: "⛔" },
  };
  const cfg = configs[verdict] ?? { cls: "bg-slate-800 border-slate-600 text-slate-300", icon: "●" };
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold tracking-wider ${cfg.cls}`}>
      <span>{cfg.icon}</span>
      {verdict}
    </span>
  );
}

/* ───────── Trade Plan Card ───────── */
function TradePlanCard({ plan }: { plan: AIAnalysisResult["tradePlan"] }) {
  const items = [
    { label: "Entry Zone", value: plan.entryZone,      color: "text-white",     bg: "bg-slate-800/80 border-slate-700" },
    { label: "Stop Loss",  value: plan.stopLoss,       color: "text-red-400",   bg: "bg-red-950/40 border-red-900/60" },
    { label: "Target 1",  value: plan.target1,         color: "text-emerald-400", bg: "bg-emerald-950/40 border-emerald-900/60" },
    { label: "Target 2",  value: plan.target2,         color: "text-emerald-300", bg: "bg-emerald-950/30 border-emerald-900/40" },
    { label: "Risk : Reward", value: plan.riskRewardRatio, color: "text-cyan-400", bg: "bg-cyan-950/40 border-cyan-900/60" },
    { label: "Holding",   value: plan.holdingPeriod,  color: "text-amber-400", bg: "bg-amber-950/30 border-amber-900/40" },
  ];

  return (
    <div className="rounded-xl border border-cyan-900/40 overflow-hidden"
      style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.04), rgba(16,185,129,0.02))" }}>
      <div className="px-4 py-2.5 border-b border-cyan-900/30 flex items-center gap-2">
        <span className="text-cyan-400 text-sm">📋</span>
        <span className="text-xs font-semibold text-cyan-400 uppercase tracking-widest">Trade Plan</span>
      </div>
      <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
        {items.map((item) => (
          <div key={item.label} className={`rounded-lg p-2.5 border ${item.bg}`}>
            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{item.label}</div>
            <div className={`text-sm font-bold font-mono ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
      <div className="mx-3 mb-3 text-xs text-slate-400 bg-red-950/30 rounded-lg p-2.5 border-l-2 border-red-600 flex gap-2">
        <span className="text-red-400 font-semibold flex-shrink-0">SL Logic:</span>
        <span className="text-slate-400">{plan.stopLossReason}</span>
      </div>
    </div>
  );
}

/* ───────── Section with colored bullets ───────── */
function AnalysisSection({
  title, items, icon, bulletColor
}: {
  title: string;
  items: string[];
  icon: string;
  bulletColor: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-800/60 flex items-center gap-2">
        <span className="text-sm">{icon}</span>
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">{title}</span>
        <span className="ml-auto text-[10px] font-mono text-slate-700 bg-slate-800 px-1.5 py-0.5 rounded">{items.length}</span>
      </div>
      <ul className="p-3 space-y-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-sm">
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${bulletColor}`} />
            <span className="text-slate-300 leading-relaxed">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────── Quick Reference bar ───────── */
function QuickRef({ stock }: { stock: ScreenedStock }) {
  const risk   = Math.max(stock.cmp - stock.defaultSL, 1);
  const reward = stock.target1 - stock.cmp;
  const rr     = (reward / risk).toFixed(1);

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-900/50 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-800/40 flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">⚡ Quick Levels</span>
      </div>
      <div className="p-3 grid grid-cols-4 gap-2">
        {[
          { label: "CMP",       value: `₹${stock.cmp.toFixed(0)}`,        color: "text-white",      bg: "bg-slate-800/60" },
          { label: "Stop Loss", value: `₹${stock.defaultSL.toFixed(0)}`,  color: "text-red-400",    bg: "bg-red-950/30 border border-red-900/40" },
          { label: "Target 1",  value: `₹${stock.target1.toFixed(0)}`,    color: "text-emerald-400",bg: "bg-emerald-950/30 border border-emerald-900/40" },
          { label: "RR Ratio",  value: `1:${rr}`,                         color: "text-cyan-400",   bg: "bg-cyan-950/30 border border-cyan-900/40" },
        ].map(item => (
          <div key={item.label} className={`rounded-lg p-2 text-center ${item.bg}`}>
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">{item.label}</div>
            <div className={`text-xs font-bold font-mono ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
      <div className="px-3 pb-2 text-[10px] text-slate-600 font-mono text-center">
        Risk ₹{risk.toFixed(0)} · Reward ₹{reward.toFixed(0)} · ATR {stock.atr.toFixed(1)}
      </div>
    </div>
  );
}

function PositionSizing({ stock }: { stock: ScreenedStock }) {
  const [capital, setCapital] = useState("90000");
  const totalCapital = Math.max(Number(capital) || 0, 0);
  const riskBudget = totalCapital * 0.01;
  const riskPerShare = Math.max(stock.cmp - stock.defaultSL, 0.01);
  const maxQty = Math.floor(riskBudget / riskPerShare);
  const capitalRequired = maxQty * stock.cmp;

  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Risk-controlled sizing</div>
          <div className="mt-1 text-xs text-slate-400">Maximum 1% account risk at the suggested stop</div>
        </div>
        <label className="flex items-center gap-2 text-[10px] text-slate-500">
          Capital
          <span className="flex items-center rounded-lg border border-slate-700 bg-slate-950/70 px-2 text-xs text-slate-300">
            ₹
            <input
              value={capital}
              onChange={(event) => setCapital(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              aria-label="Trading capital"
              className="w-24 bg-transparent px-1.5 py-1.5 text-right font-mono text-xs outline-none"
            />
          </span>
        </label>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: "Max Qty", value: `${maxQty}`, color: "text-cyan-300" },
          { label: "Capital Used", value: `₹${capitalRequired.toFixed(0)}`, color: "text-white" },
          { label: "Max Loss", value: `₹${(maxQty * riskPerShare).toFixed(0)}`, color: "text-red-300" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2 text-center">
            <div className="text-[9px] uppercase tracking-wider text-slate-600">{item.label}</div>
            <div className={`mt-1 font-mono text-xs font-bold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ───────── Empty / Loading States ───────── */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 animate-fade-in">
      <div className="relative">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-900/40 to-cyan-900/40 border border-slate-700 flex items-center justify-center">
          <svg className="w-8 h-8 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-slate-600 animate-pulse" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-slate-400 font-medium text-sm">No stock selected</p>
        <p className="text-slate-600 text-xs mt-1">Pick a stock from the list to get AI expert analysis</p>
      </div>
    </div>
  );
}

function LoadingState({ symbol }: { symbol: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 animate-fade-in">
      {/* Spinning ring */}
      <div className="relative w-16 h-16">
        <div className="absolute inset-0 rounded-full border-2 border-cyan-900/30" />
        <div className="absolute inset-0 rounded-full border-2 border-t-cyan-500 border-r-cyan-500/50 border-transparent animate-spin" />
        <div className="absolute inset-2 rounded-full border border-purple-900/30" />
        <div className="absolute inset-2 rounded-full border-t-purple-500/70 border-transparent animate-spin"
          style={{ animationDuration: "1.5s", animationDirection: "reverse" }} />
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse-glow" />
        </div>
      </div>
      <div className="text-center space-y-1">
        <p className="text-cyan-400 font-semibold text-sm">
          Gemini AI Analyzing <span className="font-mono font-bold">{symbol}</span>
        </p>
        <p className="text-slate-600 text-xs">Fetching news · Computing indicators · Writing report</p>
        <div className="flex justify-center gap-1 pt-1">
          {["Market Data", "News Scan", "AI Synthesis"].map((step, i) => (
            <span key={step} className="text-[9px] px-2 py-0.5 rounded-full border border-cyan-900/40 text-cyan-700 font-mono"
              style={{ animationDelay: `${i * 0.3}s` }}>
              {step}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────── Main Component ───────── */
export default function AIReportCard({ analysis, stock, loading }: Props) {
  if (!stock) return <EmptyState />;
  if (loading) return <LoadingState symbol={stock.symbol.replace(".NS", "")} />;
  if (!analysis) return null;

  const { tradePlan } = analysis;
  const changeUp = stock.dayChangePercent >= 0;

  return (
    <div className="p-4 space-y-4 animate-fade-in">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-xl font-black text-white tracking-tight font-mono">
              {stock.symbol.replace(".NS", "")}
            </h2>
            <div className={`text-xs font-mono font-bold px-2 py-0.5 rounded-md ${
              changeUp ? "bg-emerald-950 text-emerald-400 border border-emerald-800" : "bg-red-950 text-red-400 border border-red-800"
            }`}>
              {changeUp ? "▲" : "▼"} {Math.abs(stock.dayChangePercent).toFixed(2)}%
            </div>
          </div>
          <p className="text-sm text-slate-500 font-medium">{stock.name}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <VerdictBadge verdict={analysis.verdictBadge} />
            <span className="inline-flex items-center text-[11px] text-slate-500 bg-slate-800/80 border border-slate-700 px-2 py-1 rounded-lg">
              {stock.sector}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black font-mono text-white">
            ₹{stock.cmp.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 font-mono">
            VWAP ₹{stock.vwap.toFixed(0)} · ATR {stock.atr.toFixed(1)}
          </div>
        </div>
      </div>

      {/* ── Conviction Arc ── */}
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/40 p-4">
        <ConvictionArc score={analysis.convictionScore} />
      </div>

      {/* ── Executive Summary ── */}
      <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1 h-4 rounded-full bg-gradient-to-b from-cyan-500 to-purple-500" />
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">Executive Summary</span>
        </div>
        <p className="text-sm text-slate-200 leading-relaxed">{analysis.executiveSummary}</p>
      </div>

      {analysis.riskFlags && analysis.riskFlags.length > 0 && (
        <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-400">Guardrails triggered</div>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed text-amber-200/80">
            {analysis.riskFlags.map((flag) => <li key={flag}>• {flag}</li>)}
          </ul>
        </div>
      )}

      {/* ── Trade Plan ── */}
      <TradePlanCard plan={tradePlan} />

      {/* ── Quick Levels ── */}
      <QuickRef stock={stock} />

      <PositionSizing stock={stock} />

      {/* ── Analysis Sections ── */}
      <div className="grid gap-3">
        <AnalysisSection
          title="Technical Breakdown"
          items={analysis.technicalBreakdown}
          icon="📈"
          bulletColor="bg-cyan-500"
        />
        <AnalysisSection
          title="Fundamental Check"
          items={analysis.fundamentalCheck}
          icon="📊"
          bulletColor="bg-purple-500"
        />
        <AnalysisSection
          title="News & Catalysts"
          items={analysis.newsAndCatalysts}
          icon="📰"
          bulletColor="bg-amber-500"
        />
        <AnalysisSection
          title="Key Risks & Traps"
          items={analysis.keyRisksAndTraps}
          icon="⚠️"
          bulletColor="bg-red-500"
        />
      </div>

      {/* Footer disclaimer */}
      <div className="text-[10px] text-slate-700 text-center pb-2 border-t border-slate-800/40 pt-3">
        AI analysis is for educational purposes only. Not SEBI-registered investment advice.
      </div>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";
import type { AIAnalysisResult } from "@/lib/aiAnalyst";
import type { ScreenedStock } from "@/lib/screenerEngine";
import { getTradePlan, positionSize, formatTradeSetup, type NumericTradePlan } from '@/lib/tradePlan';
import { enforceRiskGuards } from '@/lib/analysisRules';
import { portfolioSizing, type Portfolio, type PortfolioPriorCloses } from '@/lib/portfolioEngine';
import { RVOL_SESSIONS } from '@/lib/relativeVolume';

interface Props {
  analysis: AIAnalysisResult | null;
  stock: ScreenedStock | null;
  loading: boolean;
  analysisMeta?: { cached: boolean; cachedAt: string; expiresAt: string } | null;
  onRefresh?: () => void;
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
    score >= 7 ? "STRONGER EVIDENCE" : score >= 4 ? "LIMITED EVIDENCE" : "WEAK EVIDENCE";

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
        <div className="text-xs text-slate-500 uppercase tracking-widest mb-0.5">Evidence score</div>
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
        <span className="text-xs font-semibold text-cyan-400 uppercase tracking-widest">Quant trade plan</span>
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
  const plan = getTradePlan(stock);
  const risk = plan ? plan.entryHigh-plan.stopLoss : 0;
  const reward = plan ? plan.target1-plan.entryHigh : 0;
  const rr = plan ? plan.riskRewardRatio.toFixed(1) : '—';

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-900/50 overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-800/40 flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">⚡ Quick Levels</span>
      </div>
      <div className="p-3 grid grid-cols-4 gap-2">
        {[
          { label: "CMP",       value: `₹${stock.cmp.toFixed(2)}`,        color: "text-white",      bg: "bg-slate-800/60" },
          { label: "Stop Loss", value: plan ? `₹${plan.stopLoss.toFixed(2)}` : '—', color: "text-red-400", bg: "bg-red-950/30 border border-red-900/40" },
          { label: "Target 1", value: plan ? `₹${plan.target1.toFixed(2)}` : '—', color: "text-emerald-400", bg: "bg-emerald-950/30 border border-emerald-900/40" },
          { label: "RR Ratio",  value: `1:${rr}`,                         color: "text-cyan-400",   bg: "bg-cyan-950/30 border border-cyan-900/40" },
        ].map(item => (
          <div key={item.label} className={`rounded-lg p-2 text-center ${item.bg}`}>
            <div className="text-[9px] text-slate-500 uppercase mb-0.5">{item.label}</div>
            <div className={`text-xs font-bold font-mono ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
      <div className="px-3 pb-2 text-[10px] text-slate-600 font-mono text-center">
        At zone high: risk ₹{risk.toFixed(2)} · Reward ₹{reward.toFixed(2)} · ATR {stock.atr.toFixed(2)}
      </div>
    </div>
  );
}

function PositionSizing({ plan, capital, setCapital, live, riskPercent, blocked }: {
  plan: NumericTradePlan | null; capital: string; setCapital: (value:string)=>void;
  live: ReturnType<typeof portfolioSizing> | null; riskPercent: number; blocked: boolean
}) {
  const sizing = positionSize(plan, Number(capital), riskPercent);
  const maxQty=live?.quantity??0,capitalRequired=live?.cashRequired??0;
  return (
    <div className="rounded-xl border border-slate-800/60 bg-slate-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Risk-controlled sizing</div>
          <div className="mt-1 text-xs text-slate-400">{blocked ? "Watchlist only — no entry quantity cleared" : live?.reasons.join('; ')||(!live?'Configure/review your portfolio before clearing quantity':`${riskPercent.toFixed(1)}% planned risk · portfolio limits apply`)}</div>
        </div>
        <label className="flex items-center gap-2 text-[10px] text-slate-500">
          What-if capital
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
          { label: "Planned stop risk", value: `₹${(live?.plannedRisk??0).toFixed(0)}`, color: "text-red-300" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2 text-center">
            <div className="text-[9px] uppercase tracking-wider text-slate-600">{item.label}</div>
            <div className={`mt-1 font-mono text-xs font-bold ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Isolated what-if quantity: {sizing.quantity}. This estimate ignores other positions and is not the cleared portfolio quantity.</p>
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
        <p className="text-slate-600 text-xs mt-1">Pick a stock to see chart and research</p>
      </div>
    </div>
  );
}

/* ───────── Main Component ───────── */
function cacheAgeLabel(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export default function AIReportCard({ analysis, stock, loading, analysisMeta, onRefresh }: Props) {
  const [copied, setCopied] = useState(false);
  const [capital,setCapital]=useState("90000");
  const [portfolioView,setPortfolioView]=useState<{portfolio:Portfolio;dailyCloses?:PortfolioPriorCloses|null}|null>(null);
  const [reserveMessage,setReserveMessage]=useState('');
  const activeSymbol=stock?.symbol;
  useEffect(()=>{
    let active=true;
    const read=async()=>{try{const r=await fetch('/api/portfolio',{signal:AbortSignal.timeout(14000)});if(!r.ok)throw new Error();const d=await r.json();if(active)setPortfolioView(d.portfolio?d:null);}catch{if(active)setPortfolioView(null);}};
    if(activeSymbol)void read();window.addEventListener('portfolio-updated',read);
    return()=>{active=false;window.removeEventListener('portfolio-updated',read);};
  },[activeSymbol]);

  if (!stock) return <EmptyState />;
  const hasAI = Boolean(analysis);
  analysis = enforceRiskGuards(analysis ?? {executiveSummary:'Quant research is available. AI explanation has not been generated.',technicalBreakdown:[],fundamentalCheck:[],newsAndCatalysts:[],keyRisksAndTraps:[]},stock);

  const { tradePlan } = analysis;
  const changeUp = stock.dayChangePercent >= 0;
  const symbol = stock.symbol.replace(".NS", "");
  const researchOnly = stock.mode === "longterm";
  const intraday = stock.mode === "intraday";
  const latestCandle = stock.candles.at(-1);
  const relativeVolume = stock.relativeVolume;
  const numericPlan=getTradePlan(stock);
  const portfolio=portfolioView?.portfolio;
  const blocked = analysis.verdictBadge === 'WATCHLIST ONLY';
  const riskPercent = blocked ? 0 : (stock.positionRiskPercent ?? 0);
  const liveSizing = portfolio ? portfolioSizing(portfolio,numericPlan,stock.sector,stock.symbol,riskPercent,undefined,portfolioView.dailyCloses) : null;
  const qty = liveSizing?.quantity ?? 0;
  const tradingViewUrl = `https://www.tradingview.com/symbols/NSE-${encodeURIComponent(symbol)}/`;

  const copySetup = async () => {
    if(!numericPlan)return;
    const text = formatTradeSetup(symbol,numericPlan,qty);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

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
            <VerdictBadge verdict={stock.researchQualified ? "RESEARCH SHORTLIST" : analysis.verdictBadge} />
            <span className="inline-flex items-center text-[11px] text-slate-500 bg-slate-800/80 border border-slate-700 px-2 py-1 rounded-lg">
              {stock.sector}
            </span>
            {analysisMeta && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-mono text-slate-500">
                {analysisMeta.cached ? `Cached ${cacheAgeLabel(analysisMeta.cachedAt)}` : "Fresh AI"}
                {onRefresh && <button onClick={onRefresh} className="ml-1 text-cyan-400 hover:text-cyan-200" title="Refresh AI analysis">↻ Refresh</button>}
              </span>
            )}
            {!researchOnly && <button disabled={!numericPlan} onClick={copySetup} className="rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-cyan-700 hover:text-cyan-300">
              {copied ? "Copied" : "Copy Setup"}
            </button>}
            <a href={tradingViewUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold text-slate-400 hover:border-cyan-700 hover:text-cyan-300">
              Open in TV ↗
            </a>
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black font-mono text-white">
            ₹{stock.cmp.toFixed(2)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5 font-mono">
            {stock.mode==='intraday'?`VWAP ₹${stock.vwap.toFixed(2)} · `:''}RSI14 {stock.rsi.toFixed(2)} · ATR14 {stock.atr.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 p-3 text-xs text-slate-400 space-y-1">
        <p className="font-semibold text-cyan-300">{hasAI?'AI explanation with quant guardrails':'Quant-only research — AI optional'}</p>
        {loading && <p role="status" className="text-cyan-300">Loading research explanation…</p>}
        <p>Quote: {stock.dataQuality?.quoteAt ? new Date(stock.dataQuality.quoteAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST' : 'unavailable'} · {stock.dataQuality?.quoteSource==='NSE EOD'?'Official NSE close':'Yahoo quote'}{stock.dataQuality?.quoteSource!=='NSE EOD'&&' · Feed delay: '}{stock.dataQuality?.quoteSource==='NSE EOD'?null:stock.dataQuality?.delayMinutes==null?'unknown':`${stock.dataQuality.delayMinutes} min`}</p>
        <p>{intraday ? 'Last completed 15m candle opened at ' : 'Daily candle dated '}{stock.dataQuality?.candleAt ? new Date(stock.dataQuality.candleAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata', ...(intraday ? {} : {dateStyle:'medium'})})+(intraday?' IST':''):'unavailable'}{stock.dataQuality?.candleSource==='NSE EOD'?' · official NSE candle':''}{stock.dataQuality?.incompleteCandle?' · forming candle':''}{intraday && latestCandle && ` · Close ₹${latestCandle.close.toFixed(2)}`}</p>
        {relativeVolume ? <p>RVOL {relativeVolume.value.toFixed(2)}× · {relativeVolume.session}{relativeVolume.through && ` through ${new Date(relativeVolume.through).toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false})} IST`} · {relativeVolume.volume.toLocaleString('en-IN')} shares {relativeVolume.kind === 'daily-so-far' ? 'so far ' : ''}÷ {relativeVolume.averageVolume.toLocaleString('en-IN')} average over {RVOL_SESSIONS} prior {intraday ? 'same-time' : 'daily'} sessions</p>
          : relativeVolume === null && <p>RVOL unavailable · requires a current volume reading and {RVOL_SESSIONS} comparable sessions.</p>}
        {!!stock.dataQuality?.restoredCashSessions?.length && <p>Historical NSE candles restored for {stock.dataQuality.restoredCashSessions.join(', ')}.</p>}
        <p>{stock.mode==='intraday'?'VWAP: current session. ':''} Evidence score is not a win probability.</p>
        {stock.verificationNote&&<p className="text-amber-300">{stock.verificationNote}</p>}
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
      {!researchOnly && <TradePlanCard plan={tradePlan} />}
      {numericPlan&&<div className="rounded-xl border border-slate-800 p-3 text-xs text-slate-400 space-y-2"><p className="text-cyan-300">Entry trigger: {numericPlan.trigger}</p><p>{numericPlan.invalidation}</p><p>Entry expires {new Date(numericPlan.validUntil).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST · net T1 reward/risk {numericPlan.netRiskReward.toFixed(2)} · minimum policy {numericPlan.minimumNetRR.toFixed(2)}</p><p>{numericPlan.tickSize?`Instrument tick ₹${numericPlan.tickSize}`:'Instrument tick unverified — levels are indicative; verify the broker instrument before entry.'} · Cost/slippage assumptions require broker reconciliation.</p>{portfolio&&qty>0&&<button className="text-cyan-300" onClick={async()=>{try{const r=await fetch('/api/portfolio',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:portfolio.version,action:{id:crypto.randomUUID(),type:'reserve',symbol:stock.symbol,mode:stock.mode,quantity:qty}}),signal:AbortSignal.timeout(45000)}),d=await r.json();if(!r.ok)throw new Error(d.error);setPortfolioView(d);setReserveMessage('Cash/risk reserved in your journal. No broker order was sent.');window.dispatchEvent(new Event('portfolio-updated'));}catch(e){setReserveMessage(e instanceof Error?e.message:'Reservation failed');}}}>Reserve {qty} shares in journal</button>}{reserveMessage&&<p role="status">{reserveMessage}</p>}</div>}

      {/* ── Quick Levels ── */}
      {!researchOnly && <QuickRef stock={stock} />}

      {!researchOnly && <PositionSizing plan={numericPlan} capital={capital} setCapital={setCapital} live={liveSizing} riskPercent={riskPercent} blocked={blocked} />}

      {analysis.evidence&&<details className="rounded-xl border border-slate-800 p-3 text-xs"><summary className="cursor-pointer text-cyan-300">Evidence, periods & sources</summary><div className="mt-3 space-y-3">{analysis.evidence.map(f=><div key={f.id}><p className="text-slate-300">{f.text}</p><p className="text-slate-500">{f.status} · As of {f.asOf?new Date(f.asOf).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})+' IST':'unavailable'} · <a href={f.source} target="_blank" rel="noreferrer" className="text-cyan-400">Source</a></p></div>)}</div></details>}

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
        Research setup only. Stop risk is an estimate; gaps/slippage can increase losses. Not SEBI-registered investment advice.
      </div>
    </div>
  );
}

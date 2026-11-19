"use client";
import { ScreenedStock } from "@/lib/screenerEngine";
import type { RemovedScanStock } from "@/lib/models/ScanSnapshot";

interface Props {
  stocks: ScreenedStock[];
  removedToday: RemovedScanStock[];
  selected: ScreenedStock | null;
  onSelect: (stock: ScreenedStock) => void;
  loading: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
}

const RANK_STYLES = [
  { bg: "from-amber-500 to-yellow-600", text: "text-amber-900", label: "🥇" },
  { bg: "from-slate-300 to-slate-400",  text: "text-slate-900", label: "🥈" },
  { bg: "from-orange-600 to-orange-700",text: "text-orange-100",label: "🥉" },
];

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-700`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function RvolChip({ stock }: { stock: ScreenedStock }) {
  const { rvol, relativeVolume } = stock;
  if (relativeVolume == null) return (
    <span title={relativeVolume === null ? 'Comparable volume history unavailable' : 'Refresh this snapshot to measure RVOL'} className="text-[10px] font-mono text-slate-500">RVOL —</span>
  );
  const hot = rvol >= 2.5;
  const warm = rvol >= 1.8;
  const color = hot ? 'bg-emerald-950 border-emerald-700 text-emerald-400 font-bold'
    : warm ? 'bg-cyan-950 border-cyan-800 text-cyan-400 font-bold' : 'bg-slate-800 border-slate-700 text-slate-500';
  const basis = relativeVolume.kind === 'intraday-cumulative' ? 'Same-time cumulative RVOL' : 'Daily RVOL';
  return (
    <span title={basis} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${color}`}>
      {hot ? '🔥 ' : ''}{rvol.toFixed(2)}×
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="p-3 rounded-xl border border-slate-800/60 bg-slate-900/40">
      <div className="flex justify-between mb-3">
        <div>
          <div className="skeleton h-4 w-20 mb-1.5" />
          <div className="skeleton h-3 w-28" />
        </div>
        <div className="text-right">
          <div className="skeleton h-4 w-16 mb-1.5" />
          <div className="skeleton h-3 w-12" />
        </div>
      </div>
      <div className="skeleton h-1 w-full mb-2" />
      <div className="flex gap-2">
        <div className="skeleton h-5 w-10" />
        <div className="skeleton h-5 w-10" />
        <div className="skeleton h-5 w-14 ml-auto" />
      </div>
    </div>
  );
}

export default function StockList({ stocks, removedToday, selected, onSelect, loading, emptyTitle = 'No matching setups', emptyMessage = 'No setups matched this strategy in the available scan data.' }: Props) {
  if (loading && stocks.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center px-5 text-center animate-fade-in">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-900/50 bg-cyan-950/20 shadow-lg shadow-cyan-950/20">
          <svg className="w-7 h-7 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-300">{emptyTitle}</p>
        <p className="mt-1 max-w-[190px] text-xs leading-5 text-slate-400">{emptyMessage}</p>
      </div>
    );
  }

  const qualified = stocks.filter(s => !s.nearMiss || s.researchQualified);
  const nearMiss = stocks.filter(s => s.nearMiss && !s.researchQualified);

  return (
    <div className="flex flex-col">
      {qualified.length > 0 && (
        <div className="p-3 flex flex-col gap-2">
          {qualified.some(stock=>stock.researchQualified)&&<p className="px-1 text-[10px] font-semibold uppercase tracking-widest text-cyan-300">Research shortlist · manual review</p>}
          {qualified.map((stock, i) => {
            const isSelected = selected?.symbol === stock.symbol;
            const isTop3 = i < 3 && !stock.researchQualified;
            const changeUp = stock.dayChangePercent >= 0;

            return (
              <button
                key={stock.symbol}
                onClick={() => onSelect(stock)}
                className={`group w-full text-left rounded-xl border transition-all duration-200 overflow-hidden ${
                  isSelected
                    ? "border-cyan-500/70 bg-cyan-950/30 shadow-lg shadow-cyan-900/20"
                    : "border-slate-800/60 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-800/60"
                }`}
                style={isSelected ? { boxShadow: "0 0 24px rgba(6,182,212,0.12), inset 0 0 24px rgba(6,182,212,0.03)" } : {}}
              >
                {/* Top accent line for selected */}
                {isSelected && (
                  <div className="h-0.5 bg-gradient-to-r from-cyan-500 via-cyan-400 to-transparent" />
                )}

                <div className="p-3">
                  {/* Row 1: Rank + Symbol + Price */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Rank badge */}
                      {isTop3 ? (
                        <span className={`flex-shrink-0 w-5 h-5 rounded bg-gradient-to-br ${RANK_STYLES[i].bg} flex items-center justify-center text-[9px] font-black ${RANK_STYLES[i].text}`}>
                          {i + 1}
                        </span>
                      ) : (
                        <span className="flex-shrink-0 w-5 h-5 rounded bg-slate-800 border border-slate-700 flex items-center justify-center text-[9px] font-mono text-slate-500">
                          {i + 1}
                        </span>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-sm text-white tracking-wide">
                            {stock.symbol.replace(".NS", "")}
                          </span>
                          {stock.lifecycleState === "NEW" && (
                            <span className="rounded border border-emerald-700/70 bg-emerald-950/70 px-1 py-0.5 text-[8px] font-black tracking-wide text-emerald-400">
                              NEW
                            </span>
                          )}
                          {stock.earningsRisk && (
                            <span title="Earnings or corporate event within 5 trading days" className="rounded border border-red-800/70 bg-red-950/70 px-1 py-0.5 text-[8px] font-black tracking-wide text-red-300">
                              EVENT
                            </span>
                          )}
                          {isSelected && (
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate max-w-[130px] mt-0.5">
                          {stock.name}
                        </div>
                      </div>
                    </div>

                    {/* Price */}
                    <div className="text-right flex-shrink-0">
                      <div className="font-bold text-sm font-mono text-white">
                        ₹{stock.cmp.toFixed(0)}
                      </div>
                      <div className={`text-[11px] font-mono font-medium ${changeUp ? "text-emerald-400" : "text-red-400"}`}>
                        {changeUp ? "▲" : "▼"}{Math.abs(stock.dayChangePercent).toFixed(2)}%
                      </div>
                    </div>
                  </div>

                  {/* Score bar */}
                  <div className="mb-2">
                    <MiniBar
                      value={stock.quantScore}
                      max={100}
                      color={stock.quantScore >= 75 ? "bg-emerald-500" : stock.quantScore >= 55 ? "bg-cyan-500" : "bg-amber-500"}
                    />
                  </div>

                  {/* Row 2: Chips */}
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5">
                      {/* RSI */}
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                        stock.rsi >= 60 ? "bg-emerald-950 border-emerald-800 text-emerald-400" :
                        stock.rsi <= 40 ? "bg-red-950 border-red-800 text-red-400" :
                        "bg-amber-950 border-amber-800 text-amber-400"
                      }`}>
                        RSI {stock.rsi.toFixed(0)}
                      </span>
                      {/* RVOL */}
                      <RvolChip stock={stock} />
                    </div>

                    {/* Score + Sector */}
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[10px] font-mono font-bold ${
                        stock.quantScore >= 75 ? "text-emerald-400" :
                        stock.quantScore >= 55 ? "text-cyan-400" : "text-amber-400"
                      }`}>
                        {stock.quantScore}
                      </span>
                      <span className="text-[10px] text-slate-600 max-w-[60px] truncate">
                        {stock.sector.length > 7 ? stock.sector.slice(0, 7) : stock.sector}
                      </span>
                    </div>
                  </div>
                  {stock.extensionWarning && (
                    <div className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-[10px] font-medium text-amber-400">
                      Extended move · wait for pullback
                    </div>
                  )}
                  {stock.liquidityWarning && (
                    <div className="mt-2 rounded-md border border-red-900/60 bg-red-950/25 px-2 py-1 text-[10px] font-medium text-red-300">
                      Liquidity guard · {stock.liquidityWarning}
                    </div>
                  )}
                  {stock.sectorCluster && (
                    <div className="mt-2 rounded-md border border-purple-900/60 bg-purple-950/25 px-2 py-1 text-[10px] font-medium text-purple-300">
                      Sector cluster · pick top 1–2 only
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {nearMiss.length > 0 && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2 mb-2 mt-1">
            <div className="flex-1 h-px bg-slate-800" />
            <span className="text-[10px] text-slate-600 uppercase tracking-widest font-medium">Near Miss</span>
            <div className="flex-1 h-px bg-slate-800" />
          </div>
          <div className="flex flex-col gap-2">
            {nearMiss.map((stock) => {
              const isSelected = selected?.symbol === stock.symbol;
              const changeUp = stock.dayChangePercent >= 0;
              return (
                <button
                  key={stock.symbol}
                  onClick={() => onSelect(stock)}
                  className={`w-full text-left p-3 rounded-xl border transition-all duration-200 opacity-70 hover:opacity-90 ${
                    isSelected
                      ? "border-amber-500/60 bg-amber-950/20"
                      : "border-slate-800/40 bg-slate-900/20 hover:border-slate-700/60"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-amber-950 border border-amber-800 text-amber-500">~</span>
                      <div>
                        <span className="font-semibold text-sm text-slate-300">{stock.symbol.replace(".NS", "")}</span>
                        {stock.lifecycleState === "NEW" && (
                          <span className="ml-1 rounded border border-emerald-800 bg-emerald-950/70 px-1 py-0.5 text-[8px] font-black text-emerald-400">NEW</span>
                        )}
                        {stock.earningsRisk && <span className="ml-1 rounded border border-red-800 bg-red-950/70 px-1 py-0.5 text-[8px] font-black text-red-300">EVENT</span>}
                        <div className="text-[11px] text-slate-600 truncate max-w-[120px]">{stock.name}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm text-slate-400">₹{stock.cmp.toFixed(0)}</div>
                      <div className={`text-[11px] font-mono ${changeUp ? "text-emerald-500" : "text-red-500"}`}>
                        {changeUp ? "+" : ""}{stock.dayChangePercent.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  {stock.extensionWarning && (
                    <div className="mt-2 text-[10px] text-amber-500">Extended move · do not chase</div>
                  )}
                  {stock.sectorCluster && <div className="mt-2 text-[10px] text-purple-400">Sector cluster · pick top 1–2 only</div>}
                  {stock.liquidityWarning && <div className="mt-2 text-[10px] text-red-300">Liquidity guard · {stock.liquidityWarning}</div>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {removedToday.length > 0 && (
        <div className="border-t border-slate-800/70 px-3 pb-3 pt-2">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-widest text-slate-600">Removed Today</span>
            <span className="rounded-full border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-[10px] font-mono text-slate-500">{removedToday.length}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {removedToday.slice(0, 8).map((item) => (
              <div key={`${item.symbol}-${new Date(item.removedAt).getTime()}`} className="rounded-lg border border-slate-800/60 bg-slate-950/40 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-400">{item.symbol.replace(".NS", "")}</span>
                  <span className="text-[10px] font-mono text-slate-600">{item.quantScore}</span>
                </div>
                <div className="mt-1 text-[10px] leading-4 text-slate-600">{item.reason}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

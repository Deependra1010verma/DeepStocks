"use client";

export interface SectorStrength {
  sector: string;
  changePercent: number;
  index?: string;
}

interface Props {
  available?: boolean;
  regime: "BULLISH" | "NEUTRAL" | "BEARISH" | null;
  niftyClose: string | null;
  ema20: string | null;
  ema50: string | null;
  indiaVix?: string | null;
  defensiveMode?: boolean;
  riskMultiplier?: number;
  regimeReason?: string | null;
  message: string | null;
  loading: boolean;
  topSectors?: SectorStrength[];
  session?: {
    state: "PRE_OPEN" | "LIVE" | "CLOSED" | "UNKNOWN";
    label: string;
    message: string;
    timeIST: string;
  };
}

export default function MarketRegimeBadge({
  available, regime, niftyClose, ema20, ema50, indiaVix, defensiveMode, riskMultiplier, regimeReason, loading, topSectors = [], session
}: Props) {
  if (loading) {
    return (
      <div className="flex items-center gap-3">
        <div className="skeleton h-7 w-48 rounded-lg" />
        <div className="skeleton h-7 w-32 rounded-lg" />
        <div className="skeleton h-7 w-32 rounded-lg" />
      </div>
    );
  }

  const regimeConfig = {
    BULLISH: {
      ring: "border-emerald-500",
      bg: "bg-emerald-500/10",
      text: "text-emerald-400",
      dot: "bg-emerald-400",
      glow: "shadow-emerald-500/20",
      icon: "▲",
      label: "BULLISH",
    },
    BEARISH: {
      ring: "border-red-500",
      bg: "bg-red-500/10",
      text: "text-red-400",
      dot: "bg-red-400",
      glow: "shadow-red-500/20",
      icon: "▼",
      label: "BEARISH",
    },
    NEUTRAL: {
      ring: "border-amber-500",
      bg: "bg-amber-500/10",
      text: "text-amber-400",
      dot: "bg-amber-400",
      glow: "shadow-amber-500/20",
      icon: "◆",
      label: "NEUTRAL",
    },
  };

  const cfg = regimeConfig[regime ?? "NEUTRAL"];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Regime pill */}
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${cfg.ring} ${cfg.bg} shadow-lg ${cfg.glow}`}
        style={{ boxShadow: `0 0 16px var(--tw-shadow-color)` }}
      >
        {/* Animated dot */}
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${cfg.dot} opacity-60`} />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.dot}`} />
        </span>
        <span className={`font-bold text-xs tracking-widest ${cfg.text}`}>
          NIFTY {available===false ? 'DATA UNAVAILABLE' : `${cfg.icon} ${cfg.label}`}
        </span>
        {niftyClose && (
          <span className="text-xs opacity-60 font-mono hidden lg:inline">
            ₹{niftyClose}
          </span>
        )}
        {ema20 && ema50 && (
          <span className="text-xs opacity-50 hidden xl:inline font-mono">
            E20:{ema20} · E50:{ema50}
          </span>
        )}
        {indiaVix && (
          <span className={`text-xs font-mono hidden lg:inline ${defensiveMode ? "text-red-300" : "opacity-60"}`} title={regimeReason ?? undefined}>
            VIX:{indiaVix}
          </span>
        )}
      </div>

      {available === false ? (
        <span className="inline-flex rounded-md border border-amber-800/70 bg-amber-950/50 px-2 py-1 text-[10px] font-bold tracking-wider text-amber-300">
          NEW-ENTRY SIZING PAUSED
        </span>
      ) : defensiveMode && (
        <span className="inline-flex items-center gap-1 rounded-md border border-red-800/70 bg-red-950/50 px-2 py-1 text-[10px] font-bold tracking-wider text-red-300">
          DEFENSIVE · {riskMultiplier === 0.5 ? "0.5% risk" : "reduced risk"}
        </span>
      )}

      {/* Hot sectors */}
      {session && (
        <span
          title={`${session.message} · ${session.timeIST}`}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-bold tracking-wider ${
            session.state === "LIVE"
              ? "border-emerald-800/70 bg-emerald-950/50 text-emerald-400"
              : session.state === "PRE_OPEN"
              ? "border-amber-800/70 bg-amber-950/50 text-amber-400"
              : "border-slate-700 bg-slate-900/70 text-slate-400"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${session.state === "LIVE" ? "bg-emerald-400 animate-pulse" : session.state === "PRE_OPEN" ? "bg-amber-400" : "bg-slate-500"}`} />
          {session.label}
        </span>
      )}

      {/* Hot sectors */}
      {topSectors.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-slate-500 font-medium hidden sm:inline">SECTORS VS NIFTY · 20 SESSIONS</span>
          {topSectors.slice(0, 4).map((s) => (
            <span
              key={s.sector}
              title={s.index}
              className={`text-xs px-2 py-1 rounded-md border font-mono font-medium transition-all ${
                s.changePercent >= 0
                  ? "bg-emerald-950/60 border-emerald-800/60 text-emerald-400 hover:border-emerald-600"
                  : "bg-red-950/60 border-red-800/60 text-red-400 hover:border-red-600"
              }`}
            >
              {s.sector.length > 8 ? s.sector.slice(0, 8) : s.sector}{" "}
              {s.changePercent >= 0 ? "▲" : "▼"}
              {Math.abs(s.changePercent).toFixed(1)} pp
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

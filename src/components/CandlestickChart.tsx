"use client";
import { useEffect, useRef } from "react";
import {
  createChart,
  IChartApi,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  LineSeries,
  TickMarkType,
  Time,
} from "lightweight-charts";
import { OHLCV } from "@/lib/indicators";

interface Props {
  candles: OHLCV[];
  ema20: number;
  ema50: number;
  ema200: number;
  symbol: string;
}

function computeEMA(closes: number[], period: number): { idx: number; value: number }[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const result: { idx: number; value: number }[] = [];
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push({ idx: period - 1, value: ema });
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push({ idx: i, value: ema });
  }
  return result;
}

const INDIA_TIME_ZONE = "Asia/Kolkata";

function asDate(time: Time): Date | null {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") {
    const parsed = new Date(time);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function formatIST(date: Date, withTime: boolean): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {}),
  }).format(date);
}

export default function CandlestickChart({ candles, symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const timestamps = candles
    .map((c) => Math.floor(new Date(c.date).getTime() / 1000))
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => a - b);
  const latestTimestamp = timestamps[timestamps.length - 1];
  const previousTimestamp = timestamps[timestamps.length - 2];
  const chartIsIntraday = typeof latestTimestamp === "number" &&
    typeof previousTimestamp === "number" &&
    latestTimestamp - previousTimestamp < 86400;
  const chartLatestDate = typeof latestTimestamp === "number" ? new Date(latestTimestamp * 1000) : null;

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const byTime = new Map<number, OHLCV>();
    for (const c of candles) {
      const ts = Math.floor(new Date(c.date).getTime() / 1000);
      if (Number.isFinite(ts)) {
        byTime.set(ts, c);
      }
    }
    const sortedEntries = Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]);
    if (sortedEntries.length === 0) return;

    const intervalSeconds = sortedEntries.length > 1
      ? sortedEntries[sortedEntries.length - 1][0] - sortedEntries[sortedEntries.length - 2][0]
      : 86400;
    const isIntraday = intervalSeconds < 86400;

    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#080e1a" },
        textColor: "#64748b",
        fontSize: 11,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      },
      grid: {
        vertLines: { color: "#1a2740" },
        horzLines: { color: "#1a2740" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#243a5e", labelBackgroundColor: "#0c1424" },
        horzLine: { color: "#243a5e", labelBackgroundColor: "#0c1424" },
      },
      rightPriceScale: {
        borderColor: "#1a2740",
        textColor: "#64748b",
      },
      timeScale: {
        borderColor: "#1a2740",
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
          const date = asDate(time);
          if (!date) return null;
          if (!isIntraday || tickMarkType === TickMarkType.Year || tickMarkType === TickMarkType.Month) {
            return new Intl.DateTimeFormat("en-IN", {
              timeZone: INDIA_TIME_ZONE,
              day: "2-digit",
              month: "short",
            }).format(date);
          }
          return new Intl.DateTimeFormat("en-IN", {
            timeZone: INDIA_TIME_ZONE,
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(date);
        },
      },
      localization: {
        locale: "en-IN",
        dateFormat: "dd MMM yy",
        timeFormatter: (time: Time) => {
          const date = asDate(time);
          return date ? `${formatIST(date, isIntraday)} IST` : "";
        },
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    chartRef.current = chart;

    const slice = sortedEntries.slice(-150);
    const sliceStartIdx = sortedEntries.length - slice.length;
    const allCloses = sortedEntries.map(([, c]) => c.close);

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#ef4444",
      borderUpColor: "#10b981",
      borderDownColor: "#ef4444",
      wickUpColor: "#10b981",
      wickDownColor: "#ef4444",
    });

    candleSeries.setData(
      slice.map(([ts, c]) => ({
        time: ts as unknown as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    const addEMASeries = (period: number, color: string, title: string) => {
      const emaPoints = computeEMA(allCloses, period).filter(
        (pt) => pt.idx >= sliceStartIdx
      );
      if (emaPoints.length === 0) return;
      const lineSeries = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        title,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      });
      lineSeries.setData(
        emaPoints.map((pt) => ({
          time: sortedEntries[pt.idx][0] as unknown as Time,
          value: pt.value,
        }))
      );
    };

    addEMASeries(20, "#06b6d4", "EMA20");
    addEMASeries(50, "#f59e0b", "EMA50");
    if (allCloses.length >= 200) addEMASeries(200, "#a855f7", "EMA200");

    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [candles, symbol]);

  if (candles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-slate-600 text-sm">No chart data</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {candles.length > 0 && (
        <div className="absolute top-2 right-2 rounded-md border border-slate-800/70 bg-slate-950/85 px-2 py-1 text-[10px] font-mono text-slate-500 backdrop-blur-sm">
          <span className="text-cyan-400">{chartIsIntraday ? "15m" : "1D"} · IST</span>
          <span className="mx-1 text-slate-700">·</span>
          {chartIsIntraday ? "Latest available" : "Latest close"}
          <span className="mx-1 text-slate-700">·</span>
          {chartLatestDate ? formatIST(chartLatestDate, chartIsIntraday) : "—"}
        </div>
      )}
      {/* EMA Legend */}
      <div className="absolute top-2 left-2 flex gap-2 text-[10px] pointer-events-none">
        <span className="font-mono text-cyan-400 bg-slate-950/80 border border-slate-800/60 px-1.5 py-0.5 rounded-md backdrop-blur-sm">
          ─ EMA20
        </span>
        <span className="font-mono text-amber-400 bg-slate-950/80 border border-slate-800/60 px-1.5 py-0.5 rounded-md backdrop-blur-sm">
          ─ EMA50
        </span>
        <span className="font-mono text-purple-400 bg-slate-950/80 border border-slate-800/60 px-1.5 py-0.5 rounded-md backdrop-blur-sm">
          ─ EMA200
        </span>
      </div>
    </div>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { NSE_SCAN_UNIVERSE } from "@/lib/niftyStocks";
import { batchFetchStockData } from "@/lib/dataFetcher";
import { runScreener } from "@/lib/screenerEngine";
import { sendTelegramAlert } from "@/lib/telegramBot";
import { connectDB } from "@/lib/db";
import { getMarketSession, isAutomationWindow, todayIST } from "@/lib/timezone";
import { SignalLedger } from "@/lib/models/SignalLedger";
import { Watchlist } from "@/lib/models/Watchlist";
import { getAppUrl } from "@/lib/appUrl";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Security: only allow cron calls with secret header
// Call this route via: GET /api/cron/sync-eod?secret=YOUR_CRON_SECRET
// Or set up a Vercel Cron Job / external cron service

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const cronSecret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  const isAuthorized = Boolean(cronSecret) && (
    bearer === cronSecret || (process.env.NODE_ENV !== "production" && secret === cronSecret)
  );
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mode = (req.nextUrl.searchParams.get("mode") ?? "intraday") as
    | "intraday"
    | "btst"
    | "swing_breakout"
    | "swing_pullback"
    | "positional"
    | "longterm";

  const session = getMarketSession();
  const results: Record<string, unknown> = { mode, session, timestamp: session.timeIST };

  if (session.state !== "LIVE" || !isAutomationWindow()) {
    return NextResponse.json({
      ...results,
      success: true,
      skipped: true,
      reason: session.state !== "LIVE" ? session.message : "Outside Telegram automation window (09:20–15:15 IST)",
    });
  }

  try {
    let dbAvailable = false;
    // 1. Try connecting to DB for caching (optional)
    try {
      await connectDB();
      dbAvailable = true;
      results.dbConnected = true;
    } catch {
      results.dbConnected = false;
    }

    // 2. Fetch market regime
    let marketRegime: "BULLISH" | "NEUTRAL" | "BEARISH" = "NEUTRAL";
    try {
      const baseUrl = getAppUrl();
      const moodRes = await fetch(`${baseUrl}/api/market-mood`);
      const moodData = await moodRes.json();
      marketRegime = moodData.regime ?? "NEUTRAL";
    } catch {
      console.warn("[Cron] Could not fetch market mood, defaulting NEUTRAL");
    }

    // 3. Run the screener
    const withFundamentals = mode === "positional" || mode === "longterm";
    const withWeekly = mode !== "intraday";
    const interval = mode === "intraday" ? "15m" : "1d";
    const symbols = NSE_SCAN_UNIVERSE.map((s) => s.symbol);
    const stockDataMap = await batchFetchStockData(symbols, interval as "1d" | "1wk" | "15m", withFundamentals, withWeekly);

    for (const [symbol, data] of stockDataMap) {
      const meta = NSE_SCAN_UNIVERSE.find((stock) => stock.symbol === symbol);
      if (meta) data.sector = meta.sector;
    }

    if (dbAvailable) {
      const openSignals = await SignalLedger.find({ status: "OPEN" }).lean();
      await Promise.all(openSignals.map(async (signal) => {
        const quote = stockDataMap.get(signal.symbol)?.currentPrice;
        if (quote == null) return;
        const status = quote <= signal.stopLoss
          ? "STOP_LOSS"
          : quote >= signal.target2
          ? "TARGET2"
          : quote >= signal.target1
          ? "TARGET1"
          : "OPEN";
        if (status !== "OPEN") {
          await SignalLedger.updateOne({ _id: signal._id }, { $set: { status, updatedAt: new Date() } });
        }
      }));
    }

    const screened = runScreener(mode, stockDataMap);

    // Inject sector
    const enriched = screened.map((s) => {
      const meta = NSE_SCAN_UNIVERSE.find((m) => m.symbol === s.symbol);
      return { ...s, sector: meta?.sector ?? "Unknown" };
    });

    results.stocksFound = enriched.length;

    // 4. Send Telegram alert
    const IST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    let alertStocks = enriched.filter((stock) => !stock.nearMiss && !stock.extensionWarning && stock.quantScore >= 65);
    if (dbAvailable) {
      const freshSignals = await Promise.all(alertStocks.map(async (stock) => {
        const signalDate = todayIST();
        const exists = await SignalLedger.exists({ symbol: stock.symbol, mode, signalDate });
        if (exists) return null;
        await SignalLedger.updateOne(
          { symbol: stock.symbol, mode, signalDate },
          {
            $set: {
              entry: stock.cmp,
              stopLoss: stock.defaultSL,
              target1: stock.target1,
              target2: stock.target2,
              quantScore: stock.quantScore,
              status: "OPEN",
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        return stock;
      }));
      alertStocks = freshSignals.filter((stock): stock is typeof enriched[number] => stock !== null);
    }
    const alertSent = await sendTelegramAlert({
      mode,
      stocks: alertStocks.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        cmp: s.cmp,
        dayChangePercent: s.dayChangePercent,
        quantScore: s.quantScore,
        rsi: s.rsi,
        rvol: s.rvol,
        defaultSL: s.defaultSL,
        target1: s.target1,
      })),
      marketRegime,
      timestamp: IST,
    });

    let watchlistAlerts = 0;
    if (dbAvailable) {
      const watchItems = await Watchlist.find({ alertEnabled: true }).lean();
      const hits = watchItems.flatMap((item) => {
        const quote = stockDataMap.get(item.symbol)?.currentPrice;
        if (quote == null || item.zoneLow == null || item.zoneHigh == null || quote < item.zoneLow || quote > item.zoneHigh) return [];
        const stock = stockDataMap.get(item.symbol);
        return stock ? [{
          symbol: item.symbol,
          name: stock.name,
          cmp: quote,
          dayChangePercent: stock.dayChangePercent,
          quantScore: 0,
          rsi: 0,
          rvol: 0,
          defaultSL: item.zoneLow,
          target1: item.zoneHigh,
        }] : [];
      });
      if (hits.length > 0) {
        watchlistAlerts = hits.length;
        await sendTelegramAlert({ mode: "watchlist", stocks: hits, marketRegime, timestamp: session.timeIST });
      }
    }

    results.alertSent = alertSent;
    results.watchlistAlerts = watchlistAlerts;
    results.success = true;

    return NextResponse.json(results);
  } catch (error) {
    console.error("[Cron] EOD sync error:", error);
    return NextResponse.json({ error: String(error), ...results }, { status: 500 });
  }
}

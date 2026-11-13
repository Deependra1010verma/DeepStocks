// Telegram Bot Alert Integration for DeepStocks
// Sends auto-scan results at scheduled times (9:25 AM Intraday, 3:00 PM BTST)
import { getAppUrl } from "./appUrl";

export interface TelegramAlertPayload {
  mode: string;
  stocks: Array<{
    symbol: string;
    name: string;
    cmp: number;
    dayChangePercent: number;
    quantScore: number;
    rsi: number;
    rvol: number;
    defaultSL: number;
    target1: number;
  }>;
  marketRegime: string;
  timestamp: string;
}

const TELEGRAM_API = "https://api.telegram.org";

function formatNumber(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function buildAlertMessage(payload: TelegramAlertPayload): string {
  const { mode, stocks, marketRegime, timestamp } = payload;

  const modeEmoji: Record<string, string> = {
    intraday: "⚡",
    btst: "🌙",
    swing_breakout: "🚀",
    swing_pullback: "📉",
    positional: "📊",
    longterm: "💎",
    watchlist: "🔔",
  };

  const regimeEmoji =
    marketRegime === "BULLISH" ? "🟢" : marketRegime === "BEARISH" ? "🔴" : "🟡";

  const modeLabel: Record<string, string> = {
    intraday: "INTRADAY",
    btst: "BTST (Buy Today Sell Tomorrow)",
    swing_breakout: "SWING BREAKOUT",
    swing_pullback: "SWING PULLBACK",
    positional: "POSITIONAL",
    longterm: "LONG-TERM",
    watchlist: "WATCHLIST ZONE",
  };

  let msg = `${modeEmoji[mode] ?? "📈"} *DeepStocks AI Scanner*\n`;
  msg += `*Mode:* ${modeLabel[mode] ?? mode.toUpperCase()}\n`;
  msg += `*Market:* ${regimeEmoji} Nifty ${marketRegime}\n`;
  msg += `*Time:* ${timestamp}\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  if (stocks.length === 0) {
    msg += `_No stocks qualified today. Market conditions tight._`;
    return msg;
  }

  stocks.slice(0, 5).forEach((s, i) => {
    const changeEmoji = s.dayChangePercent >= 0 ? "🟢" : "🔴";
    const ticker = s.symbol.replace(".NS", "");
    msg += `*${i + 1}. ${ticker}* — ₹${formatNumber(s.cmp, 0)}\n`;
    msg += `   ${changeEmoji} ${s.dayChangePercent >= 0 ? "+" : ""}${formatNumber(s.dayChangePercent)}% | RSI: ${formatNumber(s.rsi, 0)} | RVOL: ${formatNumber(s.rvol, 1)}x\n`;
    msg += `   📌 Score: ${s.quantScore}/100 | SL: ₹${formatNumber(s.defaultSL, 0)} | T1: ₹${formatNumber(s.target1, 0)}\n\n`;
  });

  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `🔗 [Open DeepStocks Dashboard](${getAppUrl()})`;

  return msg;
}

export async function sendTelegramAlert(payload: TelegramAlertPayload): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId || botToken === "your_bot_token" || chatId === "your_chat_id") {
    console.log("[Telegram] Bot not configured — skipping alert");
    return false;
  }

  try {
    const message = buildAlertMessage(payload);
    const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[Telegram] Failed to send alert:", err);
      return false;
    }

    console.log("[Telegram] Alert sent successfully for mode:", payload.mode);
    return true;
  } catch (err) {
    console.error("[Telegram] Error sending alert:", err);
    return false;
  }
}

/**
 * IST (Asia/Kolkata, UTC+5:30) timezone helpers.
 * Always use these instead of new Date().toISOString() for India market logic.
 */

/** Returns current date string in IST as "YYYY-MM-DD" */
export function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // en-CA gives YYYY-MM-DD format natively
}

/** Returns current IST date as a Date object (midnight IST) */
export function nowIST(): Date {
  const ist = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  return new Date(ist);
}

/** Converts any Date → IST date string "YYYY-MM-DD" */
export function dateToISTString(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export type MarketSession = {
  state: "PRE_OPEN" | "LIVE" | "CLOSED";
  label: "PRE-OPEN" | "LIVE MARKET" | "MARKET CLOSED";
  message: string;
  timeIST: string;
};

/** Returns the NSE session state using India Standard Time. */
export function getMarketSession(now = new Date()): MarketSession {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dayName = values.weekday;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayName);
  const hour = Number(values.hour);
  const min = Number(values.minute);
  const timeInMins = hour * 60 + min;
  const timeIST = `${values.hour}:${values.minute} IST`;

  if (day === 0 || day === 6) {
    return { state: "CLOSED", label: "MARKET CLOSED", message: "Weekend — showing previous close data", timeIST };
  }

  if (timeInMins >= 9 * 60 && timeInMins < 9 * 60 + 15) {
    return { state: "PRE_OPEN", label: "PRE-OPEN", message: "Pre-open session — prices can change before 9:15", timeIST };
  }

  const marketOpen  = 9 * 60 + 15;  // 9:15
  const marketClose = 15 * 60 + 30; // 15:30

  if (timeInMins >= marketOpen && timeInMins <= marketClose) {
    return { state: "LIVE", label: "LIVE MARKET", message: "NSE session is open", timeIST };
  }

  return { state: "CLOSED", label: "MARKET CLOSED", message: "Showing previous close data", timeIST };
}

/** Check if NSE market is currently open (Mon–Fri, 9:15–15:30 IST). */
export function isMarketOpen(): boolean {
  return getMarketSession().state === "LIVE";
}

/** Telegram automation window requested by the product: 09:20–15:15 IST. */
export function isAutomationWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return day >= 1 && day <= 5 && minutes >= 9 * 60 + 20 && minutes <= 15 * 60 + 15;
}

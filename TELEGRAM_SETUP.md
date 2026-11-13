# DeepStocks — Telegram Bot Setup Guide

## Step 1: Create Your Bot
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` command
3. Follow prompts: give it a name (e.g., "DeepStocks Alerts") and username (e.g., `deepstocks_alerts_bot`)
4. BotFather will give you a **Bot Token** like: `7234567890:AAFxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
5. Copy that token → paste in `.env.local` as `TELEGRAM_BOT_TOKEN`

## Step 2: Get Your Chat ID
1. Start a chat with your new bot (search its username, click Start)
2. Send any message to the bot
3. Visit: `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Look for `"chat":{"id":XXXXXXXXX}` — that number is your Chat ID
5. Copy it → paste in `.env.local` as `TELEGRAM_CHAT_ID`

## Step 3: Schedule Auto-Alerts (Two Options)

### Option A: Vercel Cron (If deployed on Vercel)
Add to `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/sync-eod?secret=deepstocks-cron-2024&mode=intraday", "schedule": "55 3 * * 1-5" },
    { "path": "/api/cron/sync-eod?secret=deepstocks-cron-2024&mode=btst", "schedule": "30 9 * * 1-5" }
  ]
}
```
(Times are UTC — 55 3 UTC = 9:25 AM IST, 30 9 UTC = 3:00 PM IST)

### Option B: Local Cron (Mac/Linux)
Run `crontab -e` and add:
```
25 9 * * 1-5 curl "http://localhost:3000/api/cron/sync-eod?secret=deepstocks-cron-2024&mode=intraday"
0 15 * * 1-5 curl "http://localhost:3000/api/cron/sync-eod?secret=deepstocks-cron-2024&mode=btst"
```

## Step 4: Test It
Restart dev server and visit:
`http://localhost:3000/api/cron/sync-eod?secret=deepstocks-cron-2024&mode=btst`
You should receive a Telegram message within 2-3 minutes (data fetch time).

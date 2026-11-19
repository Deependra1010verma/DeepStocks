# DeepStocks

Private NSE research screener with delayed-data transparency, guarded quant setups, optional AI explanations, snapshots, and a paper ledger. It is not an execution feed and has no established trading win-rate.

Reliability and trading-assistant work is tracked in [the upgrade backlog](./UPGRADE-BACKLOG.md). See [audit upgrades and deployment setup](./AUDIT-UPGRADES-2026-11-19.md) and the [earlier scanning fixes](./FIXES-SCANNING-2026-11-18.md).

## Local setup and private access

Use Node 22 or newer. Run `npm install`, then `npm run dev` and open http://localhost:3000. For a new installation, copy `.env.example` to `.env.local`; preserve an existing environment file.

Required server settings:

- `MONGODB_URI`: snapshots, watchlists, paper ledger, request budgets and shared job coordination.
- `APP_ACCESS_PASSWORD`: at least 12 characters. `SESSION_SECRET`: at least 32 random characters. The owner signs in with the password; signed HttpOnly, SameSite=Strict sessions expire after 12 hours. Changing either secret invalidates existing sessions.
- `AI_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL=openai/gpt-oss-120b`: optional explanations. Quant research works when AI is unavailable. Never expose any key through a `NEXT_PUBLIC_` setting.

In the current local workspace the private-access values have already been generated in the ignored `.env.local`. Read your password there; do not paste keys or passwords into chat. Configure the same server variables separately in Vercel before deployment. Code changes do not configure Vercel settings or an external scheduler.

`AI_FREE_ONLY=true` blocks Gemini and unreviewed models; it does not prove that a Groq account is on a free billing tier. Check your provider console. No paid fallback is enabled. Default ceilings are 40 attempts/day, 150,000 reserved tokens/day and 8,000 reserved tokens/minute. Failed attempts may consume reservations. Actual provider limits can be lower and are organization/project based. Billing, authentication, missing-model and rate-limit errors are separate; quota errors do not cycle through nine credentials. Gemini remains an explicit opt-in with `AI_PROVIDER=gemini`, `AI_FREE_ONLY=false`, and your configured model/key. Model availability is account-dependent.

References: [Groq structured outputs](https://console.groq.com/docs/structured-outputs), [Groq limits](https://console.groq.com/docs/rate-limits), [Gemini limits](https://ai.google.dev/gemini-api/docs/rate-limits).

## Database indexes

Automatic schema/index mutation is disabled. Inspect without changing data:

```bash
npm run db:indexes -- --check
```

After reviewing and approving the target database, `npm run db:indexes` creates/verifies identity indexes and TTL indexes for AI cache and operation records. Alert delivery IDs remain for seven days after alert expiry to prevent repeated same-day notifications. This can delete expired cache/job data; it does not erase watchlists or ledger history. Existing duplicate identity records can cause index creation to fail and must be reviewed, not silently deleted. The current configured database migration was applied and verified on 18 November 2026 after explicit user approval. Application reads enforce report expiry independently of eventual TTL cleanup.

## Data and cache rules

The browser reads the shared Mongo snapshot, polls every 15 seconds while visible, and requests a bounded refresh when stale. Polling keeps working during a refresh; saved cards remain visible. Switching strategy cancels obsolete browser work and cannot leave the new tab locked. Snapshot reads have a 15-second browser deadline and refreshes a 55-second deadline, followed by a visible error and backoff when needed. A busy shared scan returns an explicit waiting notice.

All sectors share one snapshot per mode. Acquisition is serialized across modes with a shared lease. Each request attempts at most 60 symbols (20 for fundamentals-heavy Positional/Long-Term) using six workers and persists coverage. Work resumes within a 15-minute cycle. A new cycle prioritizes pending, failed and unverified symbols. A successful partial batch can continue after 20 seconds. A completed cycle can retry its failed or unverified symbols once after 60 seconds. Provider outages and unresolved fetch failures back off five minutes. Snapshot writes check their starting revision and confirm the saved revision if acknowledgment is lost. System status shows the stage and code when a scan fails. A removal requires verified data. Mongo wire compression is enabled and at most two optional candle-cache writes run concurrently.

All evaluated qualifying stocks remain visible. At most two per sector get primary ranking, recomputed across merged batches; other qualifiers are not silently discarded. NEW/ACTIVE transitions and Removed Today use current evaluation reasons. Unknown data remains guarded. Intraday RVOL uses matching cumulative morning slots; VWAP resets each session. Daily RVOL uses the quote's IST date and the preceding 20 sessions, including the latest completed candle when the quote belongs to the next session. Live daily volume is cumulative so far, without extrapolation to a full day. EMA200 is unavailable until 200 candles exist. Confirmed daily breakouts require a completed session closing strictly above the preceding 20-bar high. Liquidity requires 20 completed sessions and is estimated using close × volume.

Charts show IST labels; source timestamps stay UTC internally. Session status and quote freshness are separate. Delayed or missing intraday quotes cannot clear an execution setup. The reviewed regular NSE cash calendar covers 2026; unknown years and unverified special sessions fail closed. Extend it using exchange circulars before 2027. [NSE 2026 calendar](https://archives.nseindia.com/content/circulars/CMTR71775.pdf).

Three AI cache checks operate together:

- Browser memory/session storage: mode, symbol, regime, provider/model and analysis version; current guard fingerprint and source freshness are checked.
- Mongo: the same checks plus absolute expiry, original analyzed CMP and server-derived stock inputs. Intraday expires at the next 15-minute bucket, Swing/BTST at 60 minutes, Positional/Long-Term at four hours, all capped at regular close. After close it expires at the next verified opening. A 0.5% intraday or 1.5% other-mode price move invalidates reuse.
- Shared Mongo leases and budgets prevent concurrent duplicate work across server instances. Candle caches include requested range and use a 10-minute TTL. Stale same-day Mongo candles cannot bypass it.

AI explains supplied facts. Code controls verdicts, confidence caps and the numeric plan shared by chart, card, copy and paper ledger. Long-term guards require completed monthly/weekly trends and multi-year financial statements. Public NSE reports provide dated ASM/GSM flags and published fixed price bands where available. Upcoming NSE events or conflicting results dates can suspend overnight setups. A matching board meeting filing supplies an exchange publication time and source link. Automatic actual-filing financial analysis, live effective price limits and complete historical corporate-action coverage require additional data. [NSE surveillance reports](https://www.nseindia.in/reports/asm) · [NSE price bands](https://nsearchives.nseindia.com/content/equities/sec_list.csv)

Swing BO, Swing PB and Positional use the official sector index where the app sector matches a published index. The index gets 10 score points when its 20-regular-session price return is above Nifty 50. A cycle keeps the same benchmark set across batches. Unmapped sectors and unavailable reports receive zero bonus. This weighting requires strategy calibration. [NSE Indices daily reports](https://www.niftyindices.com/reports/daily-reports)

Top-three prewarming is serial and stops on failure. Rapid stock/tab/search changes discard late responses. Browser cancellation prevents stale UI updates, but cannot guarantee a provider call already accepted by the server will be cancelled or refunded.

## Paper outcomes and UI

Viewing an analysis does not create a trade. Use **Track paper**, or the configured scanner's qualified-signal recording. Plans are immutable on duplicate requests. Pending entry must be touched in a later completed 15-minute candle; simulation models gaps, estimated costs/slippage, 50% T1 / 50% T2, strategy expiry, and ambiguous candle ordering. Legacy records, unfilled expiry and ambiguous/missing paths do not inflate the win-rate. Ledger statistics include sample size, Wilson interval, expectancy in R, profit factor, drawdown and RVOL/sector groups. They are paper outcomes, not verified broker fills.

Paper evaluation version 3 persists the modeled T1 fill and applies slippage to both exit legs. Earlier versions remain stored but are excluded from version-3 statistics and automatic evaluation; they are not silently rewritten. Scan and AI cache versions also invalidate earlier calculation results.

Open **Portfolio & journal** to record actual quantities, fill prices, fees, stops, available cash and observed marks. Confirm daily reconciliation before using portfolio sizing. Report quantity accounts for cash reserved for pending entries, aggregate stop risk, sector exposure, position count and realized daily loss. The isolated what-if estimate is shown separately. When the journal is open, official NSE closes and upcoming events are reviewed against recorded positions. Optional Groww comparison reports share-count differences across broker and journal positions.

Keyboard: `/` focuses search, `↑`/`↓` selects stocks. Mobile has Results/Stock details navigation. Copy Setup and chart levels use the same plan. System status shows provider configuration, reserved daily budget and job heartbeats. Network/provider failures show visible errors and retain quant research where the input data permits it.

Daily modes can fall back to the [official NSE cash and index session reports](https://www.nseindia.com/all-reports) when the latest completed Yahoo session is missing. Equity history is joined only when the prior session and prior close agree. The detail panel identifies the source. Intraday and BTST execution signals require a zero-delay, verified quote and completed 15-minute candles. A Long-Term research shortlist uses completed weekly/monthly trend and support, liquidity, and multi-year fundamentals, and requires manual review before any investment decision. Scan coverage shows both processed symbols and how many had verified data at the time of the scan. Snapshots carry ranked summaries. Selecting a stock loads its full candles and quant details before the optional AI explanation.

## Vercel and external scheduling

`vercel.json` has no recurring Vercel cron block. Configure an external scheduler with timezone **Asia/Kolkata**, method GET, and `Authorization: Bearer YOUR_CRON_SECRET`. Never put the secret in a URL. Routes check the exchange calendar and task window. Each invocation is bounded; do not run all strategies, AI, ledger and alerts in one request.

| Task | URL path | Suggested schedule, IST |
|---|---|---|
| Momentum and quality batches | `/api/cron/scan-tick` | Every minute, 09:20–15:29 and 15:45–16:59 on weekdays |
| Instrument master | `/api/cron/instruments` | 08:45 weekdays |
| Paper outcomes | `/api/cron/sync-eod?task=ledger` | Every 20 minutes and 15:55 |
| Alert delivery and watch zones | `/api/cron/sync-eod?task=alerts` | Every 5 minutes in the same windows; also 15:50 |
| Optional AI warming | `/api/cron/sync-eod?task=warm&mode=swing_breakout` | After a fresh scan; budget permitting |
| Indicative auction check | `/api/cron/preopen` | 09:12 and optionally 09:13 |

A scan queues fresh setup alerts; the alerts task delivers them with retry backoff and expiry. Set `ALERTS_DRY_RUN=false` only when Telegram delivery is wanted. Delivery IDs suppress normal duplicates; a network-success/database-failure edge can still duplicate a message (not exactly-once delivery). Pre-open counts only current, recent `PRE` quotes above the entry zone; unavailable Yahoo auction data stays unavailable. No final auction opening price is invented. [NSE pre-open specification](https://www.nseindia.com/static/products-services/equity-market-pre-open).

These jobs are not yet configured or verified on the deployed Vercel project. Test staggered runs and coverage there before relying on automation; Hobby execution/usage limits still apply even with an external scheduler.

The scan tick picks one eligible batch using saved progress. It prioritizes BTST during the final 30 minutes of continuous NSE trading. The server applies the dated session limits inside the scheduler window. Automated paper signal capture, setup notifications and AI warming require a fresh snapshot with complete verified coverage. Run `sync-eod?task=scan&mode=...` separately using a scheduler that accommodates its longer timeout.

## Validation

```bash
npm run check                 # lint, TypeScript, offline regression suite
npm run build
npm run start -- --hostname 127.0.0.1 --port 3100
npm run test:browser          # separate shell; isolated Chrome, intercepted APIs
LIVE_MARKET_TEST=1 npx vitest run --config vitest.live.config.mts tests/live/market.test.ts
```

The live market probe makes bounded Yahoo reads with Mongo writes mocked out and no AI/Telegram calls. Tests require installed Chrome for the configured browser channel. See [remediation verification](./AUDIT-FIXES-2026-11-18.md), [original audit](./AUDIT-2026-11-17.md), and `audit/2026-11-18/` evidence. No numerical trading-accuracy claim is justified until frozen strategies accumulate independent closed forward outcomes with costs.

## Optional provider comparison

`npm run benchmark:ai` uses the app's exact prompt builder on 30 synthetic cases across six modes: complete evidence, missing evidence, blocked risk, numeric/timeframe traps and untrusted news. It records raw and guarded answers, schema acceptance, latency and usage under `audit/provider-comparison/`; credentials are never included. Requests use shared daily/minute budgets, at least 31 seconds between starts, and no automatic retries. Operational failures stop the run; schema/truncation failures are recorded as outcomes. Compatible checkpoints resume without repeating completed requests. A full run takes about 16–20 minutes and consumes the application's daily allowance. The default offline suite separately verifies deterministic guard cases without calling a provider.

With Groq configured, `BENCHMARK_SECOND_MODEL=1 npm run benchmark:ai` adds a six-case paired GPT-OSS 20B pilot. `node scripts/summarize-ai-research.mjs` regenerates metrics from saved responses and manual reviews without API calls. Version/preserve artifacts before intentionally starting a new evaluation; narrative factuality requires review beyond schema checks.

On 18 November 2026, all 30 GPT-OSS 120B and six GPT-OSS 20B requests returned HTTP 200 and accepted JSON. Exploratory manual review flagged material issues in 17/30 primary answers and 4/6 secondary answers. Code protected all 24 blocked primary setups; that does not make every narrative claim reliable. These deliberately difficult synthetic cases establish neither general model accuracy nor trading profitability. Retain 120B for now; the small pilot does not establish a superior model. Gemini generation was not run under the current free-only configuration, so no Gemini/Groq accuracy winner is established. See the [full research report, examples and limitations](./RESEARCH-GROQ-2026-11-18.md).

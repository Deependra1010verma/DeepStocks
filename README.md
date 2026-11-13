This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## DeepStocks runtime features

- The scanner uses a curated 250-ish NSE discovery universe, 20-way resilient batching, daily/15-minute candles, weekly confirmation, RVOL, sector-relative scoring, and an extension filter.
- Gemini analysis is guarded by the screener state: near misses, low RVOL, extended moves, bearish weekly trend, and missing fundamentals cannot be upgraded to a high-conviction buy by the model.
- `GEMINI_API_KEY_1` through `GEMINI_API_KEY_9` are rotated on quota/auth failures. Keep them server-side in `.env.local`; do not commit the file.
- Watchlist and signal ledger APIs require MongoDB: `POST /api/watchlist`, `GET /api/ledger`.
- Telegram automation is protected by `CRON_SECRET` and runs through `/api/cron/sync-eod`; `vercel.json` schedules it every 20 minutes and the route skips non-live NSE sessions.

For a local cron smoke test:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync-eod
```

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

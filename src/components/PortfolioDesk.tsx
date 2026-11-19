'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_RISK_POLICY,
  holdingQuantityDifferences,
  type portfolioTotals,
  type Portfolio,
  type PortfolioAction,
  type RiskPolicy
} from '@/lib/portfolioEngine';
import type { ScreenerMode } from '@/lib/screenerEngine';
import type { ExchangePositionReview } from '@/lib/portfolioExchangeReview';
type Payload = {
  portfolio: Portfolio;
  totals: {
    equity: number;
    availableCash: number;
    openRisk: number;
    reservedRisk: number;
    realizedToday: number;
    dailyEquity: ReturnType<typeof portfolioTotals>['dailyEquity'];
  };
  reviews: Array<{ id: string; actions: string[] }>;
};
const field = 'rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-200 w-full';
export default function PortfolioDesk() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Payload | null>(null),
    [error, setError] = useState(''),
    [journalLoading, setJournalLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [cash, setCash] = useState(''),
    [policy, setPolicy] = useState<RiskPolicy>({ ...DEFAULT_RISK_POLICY });
  const [journalOpen, setJournalOpen] = useState(false);
  const [exchangeReviews, setExchangeReviews] = useState<ExchangePositionReview[]>([]);
  const [exchangeError, setExchangeError] = useState(false);
  const hasPositions = Boolean(data?.portfolio.positions.length);
  const journalVersion = data?.portfolio.version;
  useEffect(() => {
    if (!journalOpen || !hasPositions) return;
    const controller = new AbortController();
    const loadExchangeReview = async () => {
      try {
        const response = await fetch('/api/portfolio?exchangeReview=1', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(14000)])
        });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.exchangeReviews)) throw new Error();
        if (!controller.signal.aborted) {
          setExchangeReviews(payload.exchangeReviews);
          setExchangeError(false);
        }
      } catch {
        if (!controller.signal.aborted) setExchangeError(true);
      }
    };
    void loadExchangeReview();
    const timer = window.setInterval(loadExchangeReview, 5 * 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [journalOpen, hasPositions, journalVersion]);
  const [symbol, setSymbol] = useState(''),
    [quantity, setQuantity] = useState(''),
    [price, setPrice] = useState(''),
    [fees, setFees] = useState('0'),
    [stop, setStop] = useState(''),
    [target1, setTarget1] = useState(''),
    [target2, setTarget2] = useState(''),
    [fillTime, setFillTime] = useState(''),
    [reservationId, setReservationId] = useState(''),
    [side, setSide] = useState<'BUY' | 'SELL'>('BUY'),
    [mode, setMode] = useState<ScreenerMode>('swing_breakout');
  const read = useCallback(async () => {
    setJournalLoading(true);
    setError('');
    try {
      const r = await fetch('/api/portfolio', { signal: AbortSignal.timeout(14000) }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(d);
      setCash(String(d.portfolio.cash));
      setPolicy(d.portfolio.policy);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Portfolio unavailable');
    } finally {
      setJournalLoading(false);
    }
  }, []);
  async function mutate(action: PortfolioAction) {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/portfolio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: data.portfolio.version, action }),
          signal: AbortSignal.timeout(20000)
        }),
        d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(d);
      setCash(String(d.portfolio.cash));
      window.dispatchEvent(new Event('portfolio-updated'));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Update failed; reload to confirm stored state before retrying'
      );
    } finally {
      setBusy(false);
    }
  }
  const id = () => crypto.randomUUID();
  const [brokerHoldings, setBrokerHoldings] = useState<Array<{
    symbol: string;
    quantity: number;
    averagePrice: number;
  }> | null>(null);
  const [brokerLoading, setBrokerLoading] = useState(false);
  const [brokerError, setBrokerError] = useState('');
  const differences = brokerHoldings && data ? holdingQuantityDifferences(brokerHoldings,data.portfolio.positions) : null;
  async function compareBrokerHoldings() {
    setBrokerError('');
    setBrokerHoldings(null);
    setBrokerLoading(true);
    try {
      const response = await fetch('/api/broker', { signal: AbortSignal.timeout(10000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setBrokerHoldings(payload.holdings);
    } catch (error) {
      setBrokerError(error instanceof Error ? error.message : 'Groww holdings could not be read');
    } finally {
      setBrokerLoading(false);
    }
  }
  return (
    <>
      <button
        onClick={() => {
          dialog.current?.showModal();
          setJournalOpen(true);
          if (dialog.current) dialog.current.scrollTop = 0;
          if (!journalLoading && !busy) void read();
        }}
        className="rounded-lg border border-cyan-800 px-3 py-2 text-xs font-semibold text-cyan-300"
      >
        Portfolio & journal
      </button>
      <dialog
        ref={dialog}
        onClose={() => { setJournalOpen(false); setExchangeReviews([]); setExchangeError(false); }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto overscroll-contain bg-slate-950 p-4 text-slate-200"
        aria-labelledby="portfolio-heading"
      >
        <div className="max-w-5xl mx-auto space-y-5 pb-10">
          <div className="flex justify-between items-center">
            <h2 id="portfolio-heading" className="font-bold text-xl">
              Portfolio & daily review
            </h2>
            <button
              onClick={() => dialog.current?.close()}
              className="rounded border border-slate-700 px-4 py-2"
            >
              Close portfolio
            </button>
          </div>
          <section
            aria-labelledby="groww-holdings-heading"
            className="rounded-xl border border-slate-800 p-4 space-y-2"
          >
            <h3 id="groww-holdings-heading" className="font-semibold">
              Compare Groww holdings
            </h3>
            <button
              disabled={brokerLoading}
              className="rounded-lg border border-cyan-700 bg-cyan-950 px-3 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-60"
              onClick={() => void compareBrokerHoldings()}
            >
              {brokerLoading ? 'Reading Groww holdings…' : 'Read Groww holdings'}
            </button>
            {brokerError && (
              <p role="alert" className="text-sm text-amber-300">
                {brokerError}
              </p>
            )}
            {brokerHoldings?.length === 0 && (
              <p role="status" className="text-sm text-slate-400">
                Groww returned no holdings.
              </p>
            )}
            {brokerHoldings?.map((holding, index) => {
              const journalQuantity = data?.portfolio.positions
                .filter((position) => position.symbol === holding.symbol)
                .reduce((total, position) => total + position.quantity, 0);
              return (
                <p key={holding.symbol + index} className="text-sm">
                  {holding.symbol} · Groww {holding.quantity} shares · journal{' '}
                  {journalQuantity == null ? 'unavailable' : `${journalQuantity} shares`} · average ₹
                  {holding.averagePrice.toFixed(2)}
                </p>
              );
            })}
            {differences && (
              <div className="rounded border border-slate-800 p-3 text-sm">
                <p className={differences.length?'text-amber-300':'text-slate-300'}>
                  {differences.length ? `${differences.length} share-count differences to review` : 'Share counts match the returned holdings'}
                </p>
                {!!differences.length && <ul className="mt-1 space-y-1">
                  {differences.map(item=><li key={item.symbol}>{item.symbol} · Groww {item.broker} · journal {item.journal}</li>)}
                </ul>}
              </div>
            )}
          </section>
          <p className="text-sm text-slate-400">
            Record actual Groww fills, available cash and pending entries here. These controls record
            your journal; they send no broker orders. Reconcile changes made in Groww before using
            portfolio sizing.
          </p>
          {error && (
            <p role="alert" className="text-amber-300">
              {error}
            </p>
          )}
          <button
            disabled={journalLoading || busy}
            onClick={() => void read()}
            className="text-sm text-cyan-300 disabled:opacity-60"
          >
            {journalLoading ? 'Loading portfolio…' : 'Reload portfolio'}
          </button>
          {data && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  ['Recorded equity', data.totals.equity],
                  ['Available cash', data.totals.availableCash],
                  ['Open + reserved risk', data.totals.openRisk + data.totals.reservedRisk],
                  ['Realized today', data.totals.realizedToday]
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-slate-800 p-3">
                    <p className="text-xs text-slate-400">{label}</p>
                    <p className="font-mono">₹{Number(value).toFixed(2)}</p>
                  </div>
                ))}
              </div>
              {data.totals.dailyEquity && (
                <p className="text-xs text-slate-400" role="status">
                  {data.totals.dailyEquity.reason
                    ? `Daily equity P&L unavailable. ${data.totals.dailyEquity.reason}.`
                    : `Daily equity P&L ₹${data.totals.dailyEquity.pnl?.toFixed(2)} (${data.totals.dailyEquity.percent?.toFixed(2)}%) on opening equity ₹${data.totals.dailyEquity.openingEquity?.toFixed(2)}. Cash adjustments excluded.`}
                </p>
              )}
              <form
                className="rounded-xl border border-slate-800 p-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate({ id: id(), type: 'settings', cash: Number(cash), policy });
                }}
              >
                <h3 className="font-semibold">Cash & personal risk policy</h3>
                <p className="text-xs text-slate-400">
                  Cash means currently available cash, excluding the value of holdings. Limits are
                  editable research controls, not a validated trading strategy.
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <label>
                    Cash ₹
                    <input
                      aria-label="Portfolio cash"
                      className={field}
                      type="number"
                      min="0"
                      step="0.01"
                      value={cash}
                      onChange={(e) => setCash(e.target.value)}
                    />
                  </label>
                  {(
                    [
                      ['perTradePercent', 'Per-trade risk %'],
                      ['totalRiskPercent', 'Total open risk %'],
                      ['sectorPercent', 'Sector exposure %'],
                      ['maxPositions', 'Max positions + pending'],
                      ['dailyLossPercent', 'Daily equity loss halt %']
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        aria-label={label}
                        className={field}
                        type="number"
                        step={key === 'maxPositions' ? '1' : '0.1'}
                        min={key === 'dailyLossPercent' ? '0.1' : undefined}
                        value={policy[key]}
                        onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
                      />
                    </label>
                  ))}
                </div>
                <button disabled={busy} className="rounded bg-cyan-900 px-3 py-2">
                  Save cash & limits
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void mutate({ id: id(), type: 'reconcile' })}
                  className="ml-3 text-cyan-300"
                >
                  I reviewed holdings & pending orders today
                </button>
              </form>
              <form
                className="rounded-xl border border-slate-800 p-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void mutate({
                    id: id(),
                    type: 'fill',
                    side,
                    symbol: symbol.toUpperCase().replace(/\.NS$/, '') + '.NS',
                    sector: 'Unknown',
                    mode,
                    quantity: Number(quantity),
                    price: Number(price),
                    fees: Number(fees),
                    at: fillTime
                      ? new Date(fillTime + ':00+05:30').toISOString()
                      : new Date().toISOString(),
                    ...(side === 'BUY'
                      ? {
                          stop: stop ? Number(stop) : undefined,
                          target1: target1 ? Number(target1) : undefined,
                          target2: target2 ? Number(target2) : undefined,
                          reservationId: reservationId || undefined
                        }
                      : {})
                  });
                }}
              >
                <h3 className="font-semibold">Record an actual fill</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <label>
                    Side
                    <select
                      className={field}
                      value={side}
                      onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')}
                    >
                      <option>BUY</option>
                      <option>SELL</option>
                    </select>
                  </label>
                  <label>
                    Symbol
                    <input
                      aria-label="Fill symbol"
                      required
                      className={field}
                      value={symbol}
                      onChange={(e) => setSymbol(e.target.value)}
                    />
                  </label>
                  <label>
                    Quantity
                    <input
                      aria-label="Fill quantity"
                      required
                      type="number"
                      min="1"
                      step="1"
                      className={field}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                  </label>
                  <label>
                    Actual fill price
                    <input
                      aria-label="Fill price"
                      required
                      type="number"
                      min="0.01"
                      step="0.01"
                      className={field}
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                    />
                  </label>
                  <label>
                    Fill time (IST, optional)
                    <input
                      className={field}
                      type="datetime-local"
                      value={fillTime}
                      onChange={(e) => setFillTime(e.target.value)}
                    />
                  </label>
                  {side === 'BUY' && data.portfolio.reservations.length > 0 && (
                    <label>
                      Match reservation
                      <select
                        className={field}
                        value={reservationId}
                        onChange={(e) => setReservationId(e.target.value)}
                      >
                        <option value="">None</option>
                        {data.portfolio.reservations.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.symbol} · {r.quantity} shares
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Actual fees ₹
                    <input
                      className={field}
                      type="number"
                      min="0"
                      step="0.01"
                      value={fees}
                      onChange={(e) => setFees(e.target.value)}
                    />
                  </label>
                  <label>
                    Initial stop (optional)
                    <input
                      className={field}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={stop}
                      onChange={(e) => setStop(e.target.value)}
                    />
                  </label>
                  {side === 'BUY' && (
                    <>
                      <label>
                        First target
                        <input
                          className={field}
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={target1}
                          onChange={(e) => setTarget1(e.target.value)}
                        />
                      </label>
                      <label>
                        Second target
                        <input
                          className={field}
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={target2}
                          onChange={(e) => setTarget2(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <label>
                    Strategy
                    <select
                      className={field}
                      value={mode}
                      onChange={(e) => setMode(e.target.value as ScreenerMode)}
                    >
                      {[
                        'intraday',
                        'btst',
                        'swing_breakout',
                        'swing_pullback',
                        'positional',
                        'longterm'
                      ].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <button disabled={busy} className="rounded bg-cyan-900 px-3 py-2">
                  Record fill
                </button>
              </form>
              <section className="space-y-3">
                <h3 className="font-semibold">Open positions & exit review</h3>
                {exchangeError && <p role="status" className="text-xs text-amber-300">NSE session review currently unavailable.</p>}
                {!data.portfolio.positions.length && (
                  <p className="text-slate-400">
                    No actual positions recorded. Screener removals do not close positions.
                  </p>
                )}
                {data.portfolio.positions.map((p) => (
                  <PositionRow
                    key={p.id}
                    position={p}
                    actions={data.reviews.find((r) => r.id === p.id)?.actions ?? []}
                    exchangeReview={exchangeError ? undefined : exchangeReviews.find(r=>r.id===p.id)}
                    disabled={busy}
                    onAction={mutate}
                  />
                ))}
              </section>
              <section>
                <h3 className="font-semibold">Pending reservations</h3>
                {data.portfolio.reservations.map((r) => (
                  <div key={r.id} className="flex gap-4 py-2">
                    <span>
                      {r.symbol} · {r.quantity} shares · ₹{r.cash.toFixed(0)} reserved
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => void mutate({ id: id(), type: 'cancel', reservationId: r.id })}
                      className="text-amber-300"
                    >
                      Release after broker reconciliation
                    </button>
                  </div>
                ))}
              </section>
              <section>
                <div className="flex justify-between">
                  <h3 className="font-semibold">Journal</h3>
                  <button
                    className="text-cyan-300"
                    onClick={() => {
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(data.portfolio, null, 2)], {
                          type: 'application/json'
                        })
                      );
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'deepstocks-private-journal.json';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Export private journal
                  </button>
                </div>
                {data.portfolio.events
                  .slice(-30)
                  .reverse()
                  .map((e) => (
                    <p key={e.id} className="py-2 border-b border-slate-800 text-sm text-slate-400">
                      {new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST ·{' '}
                      {e.symbol ?? ''} · {e.note}
                      {e.realized != null ? ` · realized ₹${e.realized.toFixed(2)}` : ''}
                    </p>
                  ))}
              </section>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
function PositionRow({
  position: p,
  actions,
  exchangeReview,
  disabled,
  onAction
}: {
  position: Portfolio['positions'][number];
  actions: string[];
  exchangeReview?: ExchangePositionReview;
  disabled: boolean;
  onAction: (a: PortfolioAction) => Promise<void>;
}) {
  const [mark, setMark] = useState(''),
    [stop, setStop] = useState(''),
    [reason, setReason] = useState('');
  const [quote, setQuote] = useState('');
  const [quoteLoading, setQuoteLoading] = useState(false);
  async function readQuote() {
    setQuoteLoading(true);
    try {
      const response = await fetch('/api/broker?symbol=' + encodeURIComponent(p.symbol), {
        signal: AbortSignal.timeout(10000)
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      const q = payload.quote;
      const time = new Date(q.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      setQuote(
        `Groww ₹${q.price.toFixed(2)} · ${time} IST${q.stale ? ' · stale' : ''} · bid/ask ${q.bid ?? '—'}/${q.ask ?? '—'} · bands ${q.lower ?? '—'}–${q.upper ?? '—'}`
      );
    } catch (error) {
      setQuote(error instanceof Error ? error.message : 'Groww quote unavailable');
    } finally {
      setQuoteLoading(false);
    }
  }
  return (
    <div className="rounded-xl border border-slate-800 p-4 space-y-2">
      <p className="font-semibold">
        {p.symbol} · {p.quantity} shares · average ₹{p.averagePrice.toFixed(2)}
      </p>
      <p className="text-xs text-slate-400">
        Initial stop {p.initialStop ?? 'unavailable'} · current stop {p.stop ?? 'unavailable'} · {p.mode}
      </p>
      {actions.map((a) => (
        <p key={a} className="text-sm text-amber-200">
          {a}
        </p>
      ))}
      {exchangeReview && (
        <div className="rounded border border-slate-800 p-2 text-xs text-slate-400">
          <p>{exchangeReview.price!=null ? `NSE close ₹${exchangeReview.price.toFixed(2)} · ${exchangeReview.session}` : 'Latest NSE close unavailable'}</p>
          {exchangeReview.alerts.map(alert=><p className="text-amber-200" key={alert}>{alert}</p>)}
          {exchangeReview.upcoming.map(event=><p className="text-amber-200" key={event.day+event.label}>{event.day} · {event.label}</p>)}
        </div>
      )}
      <button
        disabled={disabled || quoteLoading}
        onClick={() => void readQuote()}
        className="text-cyan-300"
      >
        {quoteLoading ? 'Reading quote…' : 'Read Groww quote'}
      </button>
      {quote && (
        <p role="status" className="text-xs text-slate-400">
          {quote}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className={field + ' max-w-40'}
          aria-label={`Observed price ${p.symbol}`}
          placeholder="Observed price"
          type="number"
          value={mark}
          onChange={(e) => setMark(e.target.value)}
        />
        <button
          disabled={disabled}
          className="text-cyan-300"
          onClick={() =>
            void onAction({
              id: crypto.randomUUID(),
              type: 'mark',
              positionId: p.id,
              price: Number(mark),
              at: new Date().toISOString()
            })
          }
        >
          Update observed price
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          className={field + ' max-w-40'}
          aria-label={`Revised stop ${p.symbol}`}
          placeholder="Revised stop"
          type="number"
          value={stop}
          onChange={(e) => setStop(e.target.value)}
        />
        <input
          className={field + ' max-w-80'}
          aria-label={`Stop reason ${p.symbol}`}
          placeholder="Reason for tightening"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          disabled={disabled}
          className="text-cyan-300"
          onClick={() =>
            void onAction({
              id: crypto.randomUUID(),
              type: 'stop',
              positionId: p.id,
              stop: Number(stop),
              reason
            })
          }
        >
          Record stop revision
        </button>
      </div>
    </div>
  );
}

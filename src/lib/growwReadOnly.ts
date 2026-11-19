import { AppError } from './operations';
// Fixed host and allowlisted GET paths. No order/subscription endpoints exist here.
async function read(path: '/holdings/user' | '/live-data/quote', query?: Record<string, string>) {
  const token = process.env.GROWW_ACCESS_TOKEN;
  if (!token)
    throw new AppError(
      'GROWW_NOT_CONFIGURED',
      'Groww API access is not configured. Manual portfolio remains available.',
      503
    );
  const url = new URL(`https://api.groww.in/v1${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, 'X-API-VERSION': '1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(6000)
  });
  if (r.status === 401 || r.status === 403)
    throw new AppError(
      'GROWW_ACCESS_EXPIRED',
      'Groww access expired or is unavailable; renew it in your Groww account.',
      503
    );
  if (!r.ok) throw new AppError('GROWW_UNAVAILABLE', 'Groww data is temporarily unavailable.', 503);
  const data = await r.json();
  if (data.status !== 'SUCCESS' || !data.payload)
    throw new AppError('GROWW_SCHEMA', 'Groww returned an unsupported data response.', 503);
  return data.payload as Record<string, unknown>;
}
export async function readGrowwHoldings() {
  const data = await read('/holdings/user');
  if (!Array.isArray(data.holdings)) throw new AppError('GROWW_SCHEMA', 'Holdings response is invalid.');
  return data.holdings.map((row: Record<string, unknown>) => {
    if (
      typeof row.trading_symbol !== 'string' ||
      typeof row.quantity !== 'number' ||
      !Number.isFinite(row.quantity) ||
      row.quantity < 0 ||
      typeof row.average_price !== 'number' ||
      !Number.isFinite(row.average_price)
    )
      throw new AppError('GROWW_SCHEMA', 'Invalid holding values.');
    return {
      symbol: row.trading_symbol + '.NS',
      quantity: row.quantity,
      averagePrice: row.average_price,
      isin: typeof row.isin === 'string' ? row.isin : null
    };
  });
}
export function parseGrowwQuote(data: Record<string, unknown>, now = new Date()) {
  const price = Number(data.last_price),
    at = Number(data.last_trade_time),
    bid = Number(data.bid_price),
    ask = Number(data.offer_price),
    lower = Number(data.lower_circuit_limit),
    upper = Number(data.upper_circuit_limit);
  const valid =
    Number.isFinite(price) && price > 0 && Number.isFinite(at) && at <= +now + 60000 && at > 0;
  if (!valid) throw new AppError('GROWW_SCHEMA', 'Quote price or exchange timestamp is invalid.');
  return {
    price,
    at: new Date(at).toISOString(),
    bid: Number.isFinite(bid) && bid > 0 ? bid : null,
    ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    lower: Number.isFinite(lower) && lower > 0 ? lower : null,
    upper: Number.isFinite(upper) && upper > 0 ? upper : null,
    stale: +now - at > 2 * 60000,
    source: 'Groww' as const
  };
}
export async function readGrowwQuote(symbol: string) {
  if (!/^[A-Z0-9&-]{1,25}\.NS$/.test(symbol))
    throw new AppError('INVALID_SYMBOL', 'NSE symbol required', 400);
  return parseGrowwQuote(
    await read('/live-data/quote', {
      exchange: 'NSE',
      segment: 'CASH',
      trading_symbol: symbol.replace(/\.NS$/, '')
    })
  );
}

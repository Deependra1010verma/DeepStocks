import { parseCSV } from './csv';
import mongoose from 'mongoose';
import { connectDB } from './db';
import { beforeDeadline } from './deadline';
import { todayIST } from './timezone';
import { AppError } from './operations';
export const INSTRUMENT_SOURCE = 'https://growwapi-assets.groww.in/instruments/instrument.csv';
export interface Instrument {
  symbol: string;
  name: string;
  isin: string;
  tickSize: number;
  casEligible: boolean;
  buyAllowed: boolean;
  sellAllowed: boolean;
}
interface Master {
  _id: string;
  asOf: string;
  source: string;
  instruments: Instrument[];
}
let cached: Master | null = null;
export function parseInstrumentMaster(csv: string, asOf: string): Instrument[] {
  const [headers, ...rows] = parseCSV(csv),
    fields = [
      'exchange',
      'segment',
      'series',
      'trading_symbol',
      'isin',
      'tick_size',
      'underlying_symbol',
      'expiry_date',
      'buy_allowed',
      'sell_allowed',
      'name'
    ];
  if (!headers || fields.some((f) => !headers.includes(f)))
    throw new Error('Instrument master schema changed');
  const col = Object.fromEntries(fields.map((f) => [f, headers.indexOf(f)]));
  const derivativeUnderlyings = new Set(
    rows
      .filter((r) => r[col.exchange] === 'NSE' && r[col.segment] === 'FNO' && r[col.expiry_date] >= asOf)
      .map((r) => r[col.underlying_symbol])
  );
  return rows
    .filter(
      (r) =>
        r[col.exchange] === 'NSE' &&
        r[col.segment] === 'CASH' &&
        r[col.series] === 'EQ' &&
        /^[A-Z0-9&-]{1,25}$/.test(r[col.trading_symbol]) &&
        Number(r[col.tick_size]) > 0
    )
    .map((r) => ({
      symbol: r[col.trading_symbol] + '.NS',
      name: r[col.name],
      isin: r[col.isin],
      tickSize: Number(r[col.tick_size]),
      casEligible: derivativeUnderlyings.has(r[col.trading_symbol]),
      buyAllowed: /^(1|true)$/i.test(r[col.buy_allowed]),
      sellAllowed: /^(1|true)$/i.test(r[col.sell_allowed])
    }));
}
export async function getInstrumentMaster(): Promise<Master | null> {
  const day = todayIST();
  if (cached?.asOf === day) return cached;
  try {
    await beforeDeadline(connectDB, Date.now() + 2500);
    cached = await beforeDeadline(
      () =>
        mongoose.connection
          .db!.collection<Master>('market_reference')
          .findOne({ _id: 'instrument-master', asOf: day }, { maxTimeMS: 1000 }),
      Date.now() + 1500
    );
    return cached;
  } catch {
    return null;
  }
}
export function instrumentMap(master: Master | null): ReadonlyMap<string, Instrument> {
  return new Map(master?.instruments.map((i) => [i.symbol, i]) ?? []);
}
export async function saveInstrumentMaster(csv: string): Promise<{
  asOf: string;
  count: number;
  source: string;
}> {
  const day = todayIST();
  const instruments = parseInstrumentMaster(csv, day);
  if (instruments.length < 1000 || new Set(instruments.map((i) => i.symbol)).size !== instruments.length)
    throw new AppError('REFERENCE_INVALID', 'Instrument master is incomplete or ambiguous');
  const value: Master = { _id: 'instrument-master', asOf: day, source: INSTRUMENT_SOURCE, instruments };
  await connectDB();
  await mongoose.connection
    .db!.collection<Master>('market_reference')
    .replaceOne({ _id: value._id }, value, { upsert: true });
  cached = value;
  return { asOf: day, count: instruments.length, source: INSTRUMENT_SOURCE };
}
export async function refreshInstrumentMaster() {
  const response = await fetch(INSTRUMENT_SOURCE, { signal: AbortSignal.timeout(22000) });
  if (!response.ok) throw new AppError('REFERENCE_UNAVAILABLE', 'Instrument master download failed');
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('REFERENCE_UNAVAILABLE', 'Instrument master has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 60_000_000) {
      await reader.cancel();
      throw new AppError('REFERENCE_TOO_LARGE', 'Instrument master exceeded its size limit');
    }
    chunks.push(value);
  }
  return saveInstrumentMaster(Buffer.concat(chunks).toString());
}

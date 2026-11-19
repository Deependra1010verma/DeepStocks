import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectDB } from './db';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 503, public retryAfter?: number) { super(message); }
}
export async function operationCollection() {
  await connectDB();
  return mongoose.connection.db!.collection<{ _id: string; count?: number; expiresAt?: Date; owner?: string; updatedAt?: Date }>('operations');
}
export async function consumeBudget(name: string, limit: number, windowMs: number, amount = 1): Promise<void> {
  if (!Number.isFinite(limit) || limit < amount) throw new AppError('BUDGET_EXHAUSTED', 'Configured request budget exhausted.', 429, 60);
  const bucket = Math.floor(Date.now() / windowMs), id = `${name}:${bucket}`;
  try {
    const col = await operationCollection();
    await col.updateOne({ _id: id, $or: [{ count: { $exists: false } }, { count: { $lte: limit - amount } }] }, { $inc: { count: amount }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new AppError('RATE_LIMITED', 'Request budget reached. Please wait before retrying.', 429, Math.ceil(((bucket + 1) * windowMs - Date.now()) / 1000));
    throw new AppError('BUDGET_UNAVAILABLE', 'Request budget storage unavailable. Retry shortly.', 503, 15);
  }
}
export async function withLease<T>(key: string, work: () => Promise<T>, milliseconds = 55000): Promise<T> {
  const col = await operationCollection().catch(() => {
    throw new AppError('LOCK_UNAVAILABLE', 'Shared refresh coordination unavailable.', 503, 15);
  });
  const owner = randomUUID(), now = new Date();
  try {
    await col.updateOne({ _id: `lease:${key}`, $or: [{ expiresAt: { $lte: now } }, { expiresAt: { $exists: false } }] }, { $set: { owner, expiresAt: new Date(+now + milliseconds) } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new AppError('IN_PROGRESS', 'A refresh is already running. The last snapshot remains available.', 409, 5);
    throw new AppError('LOCK_UNAVAILABLE', 'Shared refresh coordination unavailable.', 503, 15);
  }
  try { return await work(); }
  finally { await col.deleteOne({ _id: `lease:${key}`, owner }).catch(() => undefined); }
}
export async function recordOperation(name: string, data: Record<string, unknown>) {
  try { const col = await operationCollection(); await col.updateOne({ _id: `health:${name}` }, { $set: { ...data, updatedAt: new Date() } }, { upsert: true }); } catch { /* No sensitive error logging. */ }
}

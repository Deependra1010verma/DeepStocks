import { readFile, stat } from 'node:fs/promises';
import mongoose from 'mongoose';
import { loader } from '../audit/2026-11-17/loader.cjs';

try {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const file = process.argv[2];
  if (!file) throw new Error('Provide today’s downloaded Groww instrument CSV');
  const load = loader(),
    { todayIST, dateToISTString } = load('src/lib/timezone.ts');
  const info = await stat(file);
  if (!info.isFile() || info.size > 60_000_000 || dateToISTString(info.mtime) !== todayIST())
    throw new Error('Select a fresh same-day file under 60 MB');
  const { saveInstrumentMaster } = load('src/lib/marketReference.ts');
  console.log(JSON.stringify(await saveInstrumentMaster(await readFile(file, 'utf8'))));
} catch (error) {
  console.error('Instrument import failed', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}

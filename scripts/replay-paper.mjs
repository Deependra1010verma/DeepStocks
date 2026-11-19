import { readFileSync } from 'node:fs';
import { loader } from '../audit/2026-11-17/loader.cjs';

try {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: node scripts/replay-paper.mjs <frozen-holdout.json>');
  const { replayHoldout } = loader()('src/lib/paperReplay.ts');
  console.log(JSON.stringify(replayHoldout(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

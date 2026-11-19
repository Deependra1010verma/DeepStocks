import type { SectorBenchmark } from './sectorBenchmarks';

export interface ScanCoverage {
  requested: number;
  attempted?: number;
  processed: number;
  verified?: number;
  failed: string[];
  deferred?: string[];
}
export interface ScanProgress {
  startedAt: string;
  processed: string[];
  failed: string[];
  deferred: string[];
  verified?: string[];
  retriedFailed?: boolean;
  sectorBenchmarks?: SectorBenchmark[];
}

function unverifiedSymbols(progress: ScanProgress): string[] {
  const verified = new Set(progress.verified);
  return progress.verified ? progress.processed.filter((symbol) => !verified.has(symbol)) : [];
}

export function scanRetrySymbols(progress: ScanProgress): string[] {
  if (progress.retriedFailed || progress.deferred.length || !progress.processed.length) return [];
  return [...new Set([...progress.failed, ...unverifiedSymbols(progress)])];
}

export function startScanProgress(
  symbols: string[],
  previous?: ScanProgress,
  now = Date.now()
): ScanProgress {
  const universe = new Set(symbols);
  if (
    previous &&
    now >= Date.parse(previous.startedAt) &&
    now - Date.parse(previous.startedAt) < 15 * 60000
  ) {
    const retry = new Set(scanRetrySymbols(previous).filter((symbol) => universe.has(symbol)));
    if (previous.deferred.length || retry.size)
      return {
        ...previous,
        processed: previous.processed.filter((s) => universe.has(s) && !retry.has(s)),
        verified: previous.verified?.filter((s) => universe.has(s)),
        failed: previous.failed.filter((s) => universe.has(s) && !retry.has(s)),
        deferred: retry.size ? [...retry] : previous.deferred.filter((s) => universe.has(s)),
        retriedFailed: !!retry.size || previous.retriedFailed
      };
  }
  // A scheduler can return after the freshness window. Start a fresh cycle but
  // preserve queue fairness so late-universe symbols are never starved.
  const priority = previous
    ? [...previous.deferred, ...previous.failed, ...unverifiedSymbols(previous), ...universe]
    : symbols;
  return {
    startedAt: new Date(now).toISOString(),
    processed: [],
    failed: [],
    deferred: [...new Set(priority)].filter((s) => universe.has(s))
  };
}

export function advanceScanProgress(
  previous: ScanProgress,
  attempted: string[],
  processed: string[],
  verified?: string[]
): ScanProgress {
  const tried = new Set(attempted),
    succeeded = new Set([...previous.processed, ...processed]);
  return {
    ...previous,
    startedAt: previous.startedAt,
    processed: [...succeeded],
    failed: [...new Set([...previous.failed, ...attempted.filter((s) => !succeeded.has(s))])].filter(
      (s) => !succeeded.has(s)
    ),
    deferred: previous.deferred.filter((s) => !tried.has(s)),
    ...(verified
      ? {
          verified: [
            ...new Set([...(previous.verified ?? []).filter((s) => !tried.has(s)), ...verified])
          ]
        }
      : {})
  };
}

export function scanCoverage(progress: ScanProgress, requested: number): ScanCoverage {
  return {
    requested,
    attempted: progress.processed.length + progress.failed.length,
    processed: progress.processed.length,
    ...(progress.verified ? { verified: progress.verified.length } : {}),
    failed: progress.failed,
    deferred: progress.deferred
  };
}

export function completeVerifiedCoverage(coverage?: ScanCoverage) {
  return Boolean(
    coverage && coverage.requested > 0 && coverage.processed === coverage.requested &&
    coverage.verified === coverage.requested && !coverage.failed.length && !coverage.deferred?.length
  );
}


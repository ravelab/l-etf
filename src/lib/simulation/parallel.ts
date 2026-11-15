// Rolling-window runs over many configs: simulate each config once over full
// history (`precompute.ts`), slice every rolling window from that series, and
// shape the per-config buckets for the requested mode (`parallel-results.ts`).
// Slicing runs on the main thread in Node and for small jobs, else across Web
// Workers.

import type { EtfConfig, PricePoint, RatePoint } from "./types";
import { buildRollingWindows, type RollingWindow } from "./rolling";
import { CONSTANT_HISTORY_WRAP_ENABLED } from "../constants";
import { precomputeAllConfigDailyValuesAsync, type PrecomputedConfigDailyValues } from "./precompute";
import { buildSimulationBucketsAsync } from "./simulation-buckets";
import {
  shapeBucketResults,
  type ConfigSimulationBucket,
  type MonthlyCpi,
  type ParallelMode,
  type ParallelResult,
  type RegularWorkerRequest,
  type VariantSimulations,
  type VariantSummaryResult,
} from "./parallel-results";
import { partitionForWorkers, runInWorker, workerCountFor } from "./worker-pool";

type SeriesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

/** Share of the progress bar the precompute pass fills; window extraction fills the rest. */
const PRECOMPUTE_PROGRESS_SHARE = 0.8;
/** A single config with fewer windows than this is cheaper on the main thread than in a worker. */
const MAIN_THREAD_WINDOW_LIMIT = 500;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function logParallelTiming(label: string, startedAt: number): void {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return;
  console.log(`[parallel] ${label}: ${(nowMs() - startedAt).toFixed(1)}ms`);
}

/**
 * One window spanning [startDate, endDate] — used when no rolling window
 * length is requested, so the run still has the full range to report on.
 */
function fullRangeWindow(prices: PricePoint[], startDate: string, endDate: string): RollingWindow[] {
  const startIdx = Math.max(0, prices.findIndex((p) => p.date >= startDate));
  // Respect endDate constraint — find the last price on or before endDate
  let endIdx = prices.length - 1;
  if (endDate) {
    while (endIdx > startIdx && prices[endIdx].date > endDate) endIdx--;
  }
  if (endIdx < startIdx) return [];
  return [{
    startIdx,
    endIdx,
    startDate: prices[startIdx].date,
    endDate: prices[endIdx].date,
    lastRealEndDate: prices[endIdx].date,
    usesSyntheticTail: false,
  }];
}

interface ExtractionJob {
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  rates: RatePoint[];
  configs: EtfConfig[];
  labels?: string[];
  paramValues?: Record<string, number>;
  monthlyCpi?: MonthlyCpi;
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
}

/** Regular windows sliced across workers, returned either shaped for `mode` or as raw buckets. */
async function runRegularWorkers<T>(
  job: ExtractionJob,
  windows: RollingWindow[],
  mode: RegularWorkerRequest["mode"],
  onWorkerDone?: (done: number, total: number) => void
): Promise<T[]> {
  const shares = partitionForWorkers(job.configs, job.precomputedDailyValues, job.labels);
  const pending = shares.map((share) => runInWorker<T[]>("regular", {
    ...share,
    windows,
    mode,
    paramValues: job.paramValues,
    monthlyCpi: job.monthlyCpi,
  } satisfies RegularWorkerRequest));

  // Await in order so progress advances monotonically and results stay in config order.
  const results: T[][] = [];
  for (let i = 0; i < pending.length; i += 1) {
    results.push(await pending[i]);
    onWorkerDone?.(i + 1, pending.length);
  }
  return results.flat();
}

/** History Wrap windows, resimulated across `wrapped-worker.ts` instances. */
async function runWrappedWorkers(job: ExtractionJob, windows: RollingWindow[]): Promise<ConfigSimulationBucket[]> {
  const shares = partitionForWorkers(job.configs, job.precomputedDailyValues);
  const results = await Promise.all(shares.map((share) => runInWorker<ConfigSimulationBucket[]>("wrapped", {
    precomputedDailyValues: share.precomputedDailyValues,
    configs: share.configs,
    windows,
    prices: job.prices,
    rates: job.rates,
    riskOffValuesByAsset: job.riskOffValuesByAsset,
    riskOffOpenValuesByAsset: job.riskOffOpenValuesByAsset,
  })));
  return results.flat();
}

/**
 * Regular windows and History Wrap windows go to different workers; merge
 * them back into one bucket per config (regular windows first, as they come
 * first in time).
 */
async function extractWithWrappedWorkers(job: ExtractionJob): Promise<ConfigSimulationBucket[]> {
  const regularWindows = job.windows.filter((window) => !window.usesSyntheticTail);
  const wrappedWindows = job.windows.filter((window) => window.usesSyntheticTail);
  const [regularBuckets, wrappedBuckets] = await Promise.all([
    regularWindows.length > 0
      ? runRegularWorkers<ConfigSimulationBucket>(job, regularWindows, "simulation-buckets")
      : Promise.resolve([]),
    wrappedWindows.length > 0 ? runWrappedWorkers(job, wrappedWindows) : Promise.resolve([]),
  ]);

  const simulationsFor = (buckets: ConfigSimulationBucket[]) => {
    const byId = new Map(buckets.map((bucket) => [bucket.configId, bucket.simulations]));
    return (configId: string) => byId.get(configId) ?? [];
  };
  const regularFor = simulationsFor(regularBuckets);
  const wrappedFor = simulationsFor(wrappedBuckets);
  return job.configs.map((config) => ({
    configId: config.id,
    simulations: [...regularFor(config.id), ...wrappedFor(config.id)],
  }));
}

/**
 * ULTRA-OPTIMIZED: Run multiple EtfConfig configs in parallel.
 *
 * `sweep` returns one `SmaComparisonRow` per config that produced any window
 * (join on `row.parameterValue`, never by index); `variants` and
 * `variant-summaries` return one labelled entry per config.
 */
export async function runParallelSimulations({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  configs,
  labels,
  paramValues,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
  monthlyCpi,
  mode,
  etfPricesByName,
  pricesByIndex,
  onProgress,
  signal,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  configs: EtfConfig[];
  labels?: string[];
  /** Sweep parameter value keyed by config.id, carried explicitly instead of parsed from the id. */
  paramValues?: Record<string, number>;
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
  monthlyCpi?: MonthlyCpi;
  mode: ParallelMode;
  etfPricesByName?: Record<string, number[]>;
  pricesByIndex?: Record<string, PricePoint[]>;
  onProgress?: (completedFraction: number, label?: string) => void;
  signal?: AbortSignal;
}): Promise<ParallelResult> {
  const totalStartedAt = nowMs();
  const precomputeStartedAt = nowMs();
  const precomputedDailyValues = await precomputeAllConfigDailyValuesAsync(
    { prices, rates, riskOffValuesByAsset, riskOffOpenValuesByAsset, etfPricesByName, pricesByIndex },
    configs,
    (completedUnits, totalUnits, label) => {
      const fraction = totalUnits > 0 ? completedUnits / totalUnits : 1;
      onProgress?.(fraction * PRECOMPUTE_PROGRESS_SHARE, label);
    },
    signal
  );
  logParallelTiming("precompute daily values", precomputeStartedAt);

  const windowsStartedAt = nowMs();
  const rollingWindows = buildRollingWindows({
    prices,
    windowLength: windowLength || 0,
    startDateConstraint: startDate,
    endDateConstraint: endDate,
    historyWrap,
  });
  const windows = rollingWindows.length === 0 && !windowLength
    ? fullRangeWindow(prices, startDate, endDate)
    : rollingWindows;
  logParallelTiming(`build ${windows.length} rolling windows`, windowsStartedAt);

  const job: ExtractionJob = {
    precomputedDailyValues,
    windows,
    prices,
    rates,
    configs,
    labels,
    paramValues,
    monthlyCpi,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
  };
  const extractionStartedAt = nowMs();
  const shapeContext = { configs, labels, paramValues, monthlyCpi };
  const shouldRunMainThreadOnly =
    typeof Worker === "undefined" ||
    workerCountFor(configs.length) <= 1 ||
    (configs.length === 1 && windows.length < MAIN_THREAD_WINDOW_LIMIT);

  let result: ParallelResult;
  if (shouldRunMainThreadOnly) {
    const buckets = await buildSimulationBucketsAsync(
      precomputedDailyValues,
      windows,
      prices,
      { rates, configs, riskOffValuesByAsset, riskOffOpenValuesByAsset },
      (completed, total, label) => {
        const fraction = total > 0 ? completed / total : 1;
        onProgress?.(PRECOMPUTE_PROGRESS_SHARE + fraction * (1 - PRECOMPUTE_PROGRESS_SHARE), label);
      },
      signal
    );
    result = shapeBucketResults(mode, buckets, shapeContext);
    logParallelTiming("main-thread extraction", extractionStartedAt);
  } else if (windows.some((window) => window.usesSyntheticTail)) {
    const buckets = await extractWithWrappedWorkers(job);
    onProgress?.(0.95, "Preparing results...");
    result = shapeBucketResults(mode, buckets, shapeContext);
    logParallelTiming("wrapped extraction", extractionStartedAt);
  } else {
    result = await runRegularWorkers(job, windows, mode, (done, total) => {
      onProgress?.(0.85 + (done / total) * 0.15, "Preparing results...");
    }) as ParallelResult;
    logParallelTiming("worker extraction", extractionStartedAt);
  }

  onProgress?.(1, "Preparing results...");
  logParallelTiming("TOTAL", totalStartedAt);
  return result;
}

export async function runParallelVariants({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  variants,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
  onProgress,
  signal,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  variants: Array<{ label: string; config: EtfConfig }>;
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
  /** (done, total) for the compare-letfs progress bar — NOT the engine's (fraction, label). */
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<VariantSimulations[]> {
  const total = variants.length;
  return runParallelSimulations({
    prices,
    rates,
    windowLength,
    startDate,
    endDate,
    historyWrap,
    configs: variants.map((v) => v.config),
    labels: variants.map((v) => v.label),
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    mode: "variants",
    // The engine reports an overall completed fraction; callers here want a
    // (done, total) count, so translate rather than drop the callback.
    onProgress: onProgress
      ? (completedFraction: number) =>
          onProgress(Math.min(total, Math.round(completedFraction * total)), total)
      : undefined,
    signal,
  }) as Promise<VariantSimulations[]>;
}

export async function runParallelVariantSummaries({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  variants,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
  monthlyCpi,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  variants: Array<{ label: string; config: EtfConfig }>;
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
  monthlyCpi?: MonthlyCpi;
}): Promise<VariantSummaryResult[]> {
  return runParallelSimulations({
    prices,
    rates,
    windowLength,
    startDate,
    endDate,
    historyWrap,
    configs: variants.map((v) => v.config),
    labels: variants.map((v) => v.label),
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    monthlyCpi,
    mode: "variant-summaries",
  }) as Promise<VariantSummaryResult[]>;
}

// Server-safe rolling-window sweep orchestration for the heavy MCP tools.
//
// This is the server-side counterpart to the `runSweepForPreset` callbacks that
// live inside the `"use client"` compare pages: it builds the same inputs and
// calls the shared engine (`runParallelSimulations`, mode "sweep"), but loads
// data via the server query layer instead of the browser fetch path. Workers
// are unavailable server-side, so `runParallelSimulations` takes its
// single-threaded main-thread fallback.
//
// Breadth is bounded by a *time* budget (`compute-budget.ts`) rather than a flat
// config count, and the config list is run in chunks (`sweep-chunking.ts`) so
// peak heap stays flat however wide the sweep — the engine holds a full daily
// series per config for the life of one call, which is what actually capped
// breadth before. See `limits.ts` for the structural caps that remain.

import { runParallelSimulations } from "@/lib/simulation/parallel";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import type { EtfConfig, PricePoint, RatePoint, SmaComparisonRow } from "@/lib/simulation/types";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";
import { throwIfAborted } from "@/lib/abort";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";
import {
  MCP_SWEEP_BUDGET_MS,
  createDeadline,
  isDeadlineExpired,
  type Deadline,
} from "@/lib/mcp/compute-budget";
import {
  SWEEP_CHUNK_SIZE,
  buildGlobalParamValues,
  chunkConfigs,
  chunkProgressFraction,
} from "@/lib/mcp/sweep-chunking";

interface RollingSweepRow {
  id: string;
  label: string;
  stats: SmaComparisonRow;
}

interface RollingSweepResult {
  /** One row per config that produced at least one window, in config order. */
  rows: RollingSweepRow[];
  /** True when the time budget stopped the sweep before every config ran. */
  truncated: boolean;
  evaluatedConfigs: number;
  totalConfigs: number;
}

/** Engine progress as a 0..1 fraction with a human-readable stage label. */
export type SweepProgress = (fraction: number, label?: string) => void;

interface SweepInputs {
  prices: PricePoint[];
  rates: RatePoint[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}

/**
 * Load prices, borrow rates, and the aligned risk-off series a set of configs
 * needs, over a range widened by the longest SMA warm-up among them.
 */
async function loadSweepInputs(params: {
  index: "sp500" | "nasdaq100";
  configs: EtfConfig[];
  startDate: string;
  endDate: string;
}): Promise<SweepInputs> {
  const { index, configs, startDate, endDate } = params;
  const warmUpDays = Math.max(0, ...configs.map((c) => (c.smaEnabled ? c.smaPeriod : 0)));
  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);

  const [prices, rates] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
  ]);
  if (prices.length < 2) {
    throw new McpToolError(`Not enough price data for ${index} in ${startDate}..${endDate}.`);
  }

  const riskOffAssets = Array.from(
    new Set(configs.filter((c) => c.smaEnabled).map((c) => c.riskOffAsset)),
  );
  if (riskOffAssets.length === 0) return { prices, rates };

  const raw = await loadRiskOffRawSeriesForAssets(riskOffAssets, warmUpStart, endDate);
  const aligned = alignRiskOffPriceSeries(prices, raw);
  return {
    prices,
    rates,
    riskOffValuesByAsset: aligned.closeValuesByAsset,
    riskOffOpenValuesByAsset: aligned.openValuesByAsset,
  };
}

/**
 * Run a rolling-window sweep for a set of configs that all share one index.
 * Returns one aggregate stats row per config, in config order.
 *
 * Market data is loaded once and reused by every chunk; only the engine's
 * per-config precomputation is re-entered, at ~50 ms of setup per chunk. The
 * deadline is checked *between* chunks, so the first chunk always runs and a
 * caller that runs out of budget still gets the rows it paid for, flagged
 * `truncated` — far more useful than a 300 s function timeout with nothing.
 */
export async function runRollingSweep(params: {
  index: "sp500" | "nasdaq100";
  configs: EtfConfig[];
  windowLength: number;
  startDate: string;
  endDate: string;
  onProgress?: SweepProgress;
  signal?: AbortSignal;
  /** Budget window for the whole sweep. Defaults to `MCP_SWEEP_BUDGET_MS`. */
  deadline?: Deadline;
  /** Configs per engine call. Overridable for tests; defaults to `SWEEP_CHUNK_SIZE`. */
  chunkSize?: number;
}): Promise<RollingSweepResult> {
  const { index, configs, windowLength, startDate, endDate, onProgress, signal } = params;
  if (configs.length === 0) throw new McpToolError("No strategies to evaluate.");
  throwIfAborted(signal);

  const deadline = params.deadline ?? createDeadline(MCP_SWEEP_BUDGET_MS);
  const inputs = await loadSweepInputs({ index, configs, startDate, endDate });
  throwIfAborted(signal);

  // Stamped over the WHOLE list, then shared by every chunk: the join below
  // reads `row.parameterValue`, so a chunk-local restamp would make later
  // chunks' rows overwrite earlier ones.
  const paramValues = buildGlobalParamValues(configs);
  const chunks = chunkConfigs(configs, params.chunkSize ?? SWEEP_CHUNK_SIZE);

  const rows: SmaComparisonRow[] = [];
  let evaluatedConfigs = 0;
  let truncated = false;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    throwIfAborted(signal);
    if (chunkIndex > 0 && isDeadlineExpired(deadline)) {
      truncated = true;
      break;
    }

    const chunkRows = (await runParallelSimulations({
      ...inputs,
      windowLength,
      startDate,
      endDate,
      historyWrap: false,
      configs: chunk,
      paramValues,
      mode: "sweep",
      signal,
      onProgress: onProgress
        ? (fraction, label) =>
            onProgress(chunkProgressFraction(chunkIndex, chunks.length, fraction), label)
        : undefined,
    })) as SmaComparisonRow[];

    rows.push(...chunkRows);
    evaluatedConfigs += chunk.length;
  }

  onProgress?.(1, "Preparing results...");
  return {
    rows: joinSweepRowsToConfigs(configs, rows),
    truncated,
    evaluatedConfigs,
    totalConfigs: configs.length,
  };
}

/**
 * Join per-config sweep rows back onto their configs.
 *
 * mode "sweep" drops any config whose bucket came back empty (e.g. a leveraged
 * config wiped out before the first window), so `rows` is config order *minus
 * the drops* and cannot be indexed positionally — doing so shifts every row
 * after a drop onto the next config. `paramValues` stamps each row's
 * `parameterValue` with its owning config's index, so join on that instead.
 * Same rule the rolling-window buckets follow (see `joinByWindow`).
 */
export function joinSweepRowsToConfigs(
  configs: EtfConfig[],
  rows: SmaComparisonRow[]
): RollingSweepRow[] {
  const rowByConfigIdx = new Map<number, SmaComparisonRow>();
  for (const row of rows) {
    if (row != null) rowByConfigIdx.set(row.parameterValue, row);
  }

  return configs
    .map((c, i) => ({ id: c.id, label: c.name, stats: rowByConfigIdx.get(i) }))
    .filter((r): r is RollingSweepRow => r.stats != null);
}

/**
 * Run one config over every rolling window and return the per-window points
 * (mode "variants") rather than the aggregate row — the raw material for the
 * percentile / histogram output in `window-distribution.ts`.
 */
export async function runRollingWindowPoints(params: {
  index: "sp500" | "nasdaq100";
  config: EtfConfig;
  windowLength: number;
  startDate: string;
  endDate: string;
  onProgress?: SweepProgress;
  signal?: AbortSignal;
}): Promise<RollingSimulationPoint[]> {
  const { index, config, windowLength, startDate, endDate, onProgress, signal } = params;
  throwIfAborted(signal);
  const inputs = await loadSweepInputs({ index, configs: [config], startDate, endDate });

  // Goes straight to `runParallelSimulations` rather than through
  // `runParallelVariants`: that wrapper's `onProgress` is typed for the
  // compare-letfs page's (done, total) progress bar, while the engine reports
  // (fraction, label). Same mode, same result shape.
  const results = (await runParallelSimulations({
    ...inputs,
    windowLength,
    startDate,
    endDate,
    historyWrap: false,
    configs: [config],
    labels: [config.name],
    mode: "variants",
    onProgress,
    signal,
  })) as Array<{ label: string; simulations: RollingSimulationPoint[] }>;
  return results[0]?.simulations ?? [];
}

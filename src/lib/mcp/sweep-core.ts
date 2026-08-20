// Server-safe rolling-window sweep orchestration for the heavy MCP tools.
//
// This is the server-side counterpart to the `runSweepForPreset` callbacks that
// live inside the `"use client"` compare pages: it builds the same inputs and
// calls the shared engine (`runParallelSimulations`, mode "sweep"), but loads
// data via the server query layer instead of the browser fetch path. Workers
// are unavailable server-side, so `runParallelSimulations` takes its
// single-threaded main-thread fallback — acceptable for the bounded config
// counts the tools enforce (see `limits.ts`).

import { runParallelSimulations } from "@/lib/simulation/parallel";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import type { EtfConfig, PricePoint, RatePoint, SmaComparisonRow } from "@/lib/simulation/types";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";

export interface RollingSweepRow {
  id: string;
  label: string;
  stats: SmaComparisonRow;
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
 */
export async function runRollingSweep(params: {
  index: "sp500" | "nasdaq100";
  configs: EtfConfig[];
  windowLength: number;
  startDate: string;
  endDate: string;
  onProgress?: SweepProgress;
}): Promise<RollingSweepRow[]> {
  const { index, configs, windowLength, startDate, endDate, onProgress } = params;
  if (configs.length === 0) throw new McpToolError("No strategies to evaluate.");

  const inputs = await loadSweepInputs({ index, configs, startDate, endDate });

  const rows = (await runParallelSimulations({
    ...inputs,
    windowLength,
    startDate,
    endDate,
    historyWrap: false,
    configs,
    paramValues: Object.fromEntries(configs.map((c, i) => [c.id, i])),
    mode: "sweep",
    onProgress,
  })) as SmaComparisonRow[];

  // mode "sweep" returns one row per config in config order (the compare pages
  // rely on the same ordering, e.g. baseline-first). Guard against a config
  // whose row was dropped (wiped out).
  return configs
    .map((c, i) => ({ id: c.id, label: c.name, stats: rows[i] }))
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
}): Promise<RollingSimulationPoint[]> {
  const { index, config, windowLength, startDate, endDate, onProgress } = params;
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
  })) as Array<{ label: string; simulations: RollingSimulationPoint[] }>;
  return results[0]?.simulations ?? [];
}

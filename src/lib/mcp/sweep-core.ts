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
import type { EtfConfig, SmaComparisonRow } from "@/lib/simulation/types";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";

export interface RollingSweepRow {
  id: string;
  label: string;
  stats: SmaComparisonRow;
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
}): Promise<RollingSweepRow[]> {
  const { index, configs, windowLength, startDate, endDate } = params;
  if (configs.length === 0) throw new McpToolError("No strategies to evaluate.");

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
  let riskOffValuesByAsset;
  let riskOffOpenValuesByAsset;
  if (riskOffAssets.length > 0) {
    const raw = await loadRiskOffRawSeriesForAssets(riskOffAssets, warmUpStart, endDate);
    const aligned = alignRiskOffPriceSeries(prices, raw);
    riskOffValuesByAsset = aligned.closeValuesByAsset;
    riskOffOpenValuesByAsset = aligned.openValuesByAsset;
  }

  const rows = (await runParallelSimulations({
    prices,
    rates,
    windowLength,
    startDate,
    endDate,
    historyWrap: false,
    configs,
    paramValues: Object.fromEntries(configs.map((c, i) => [c.id, i])),
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    mode: "sweep",
  })) as SmaComparisonRow[];

  // mode "sweep" returns one row per config in config order (the compare pages
  // rely on the same ordering, e.g. baseline-first). Guard against a config
  // whose row was dropped (wiped out).
  return configs
    .map((c, i) => ({ id: c.id, label: c.name, stats: rows[i] }))
    .filter((r): r is RollingSweepRow => r.stats != null);
}

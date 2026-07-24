// Server-safe core for `compare_letfs`: compare several simulated leveraged-ETF
// presets across historical rolling windows and return percentile outcome
// distributions. Mirrors /compare-letfs but server-side; runs each index group
// through `runParallelVariants` (mode "variants") to get per-window points, then
// computes percentiles.

import { runParallelVariants } from "@/lib/simulation/parallel";
import { percentile } from "@/lib/strategy-percentiles";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import type { EtfConfig } from "@/lib/simulation/types";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { getDefaultSmaBuffer, getDefaultSmaPeriod, DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { makeSweepEtfConfig, type SweepPresetDef } from "@/lib/simulation/sweep-items";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";

type IndexKey = "sp500" | "nasdaq100";
type RiskOffAsset = EtfConfig["riskOffAsset"];

export interface LetfCompareInput {
  presets: string[];
  smaEnabled: boolean;
  smaPeriod?: number;
  smaUpperBuffer?: number;
  smaLowerBuffer?: number;
  riskOffAsset?: RiskOffAsset;
  windowLength: number;
  startDate?: string;
  endDate?: string;
}

export interface LetfCompareRow {
  preset: string;
  index: IndexKey;
  windows: number;
  winRatePct: number;
  avgCagrPct: number;
  cagrPct: { p10: number; p50: number; p90: number };
  finalMultiple: { p10: number; p50: number; p90: number };
  medianMaxDrawdownPct: number;
}

function presetDefFromKey(key: string): { def: SweepPresetDef; simulated: boolean; index: IndexKey } {
  const preset = ETF_PRESETS[key];
  if (!preset) throw new McpToolError(`Unknown preset "${key}".`);
  return {
    def: {
      name: preset.name,
      leverage: preset.leverage,
      expenseRatio: preset.expenseRatio,
      simulated: preset.simulated,
      index: preset.index,
    },
    simulated: preset.simulated,
    index: preset.index,
  };
}

function pctStats(simulations: Array<{ finalValue: number; nonLeveragedFinalValue: number; cagr: number; maxDrawdownPct: number }>) {
  const cagrs = simulations.map((s) => s.cagr).sort((a, b) => a - b);
  const finals = simulations.map((s) => s.finalValue).sort((a, b) => a - b);
  const dds = simulations.map((s) => s.maxDrawdownPct).sort((a, b) => a - b);
  const wins = simulations.filter((s) => s.finalValue > s.nonLeveragedFinalValue).length;
  const avgCagr = cagrs.reduce((a, b) => a + b, 0) / (cagrs.length || 1);
  return {
    windows: simulations.length,
    winRatePct: (wins / (simulations.length || 1)) * 100,
    avgCagrPct: avgCagr,
    cagrPct: { p10: percentile(cagrs, 0.1), p50: percentile(cagrs, 0.5), p90: percentile(cagrs, 0.9) },
    finalMultiple: { p10: percentile(finals, 0.1), p50: percentile(finals, 0.5), p90: percentile(finals, 0.9) },
    medianMaxDrawdownPct: percentile(dds, 0.5),
  };
}

/**
 * Run the cross-LETF rolling comparison. Simulated presets only (real ETFs lack
 * the long history rolling windows need).
 */
export async function runLetfComparison(input: LetfCompareInput): Promise<LetfCompareRow[]> {
  const startDate = input.startDate ?? "1885-01-01";
  const endDate = input.endDate ?? new Date().toISOString().slice(0, 10);

  // Resolve presets, reject real ones, group by index.
  const byIndex = new Map<IndexKey, Array<{ label: string; config: EtfConfig }>>();
  for (const key of input.presets) {
    const { def, simulated, index } = presetDefFromKey(key);
    if (!simulated) {
      throw new McpToolError(
        `Preset "${key}" is a real-ETF series; compare_letfs uses simulated series over long history. Use its simulated variant.`,
      );
    }
    const smaPeriod = input.smaPeriod ?? getDefaultSmaPeriod(index);
    const config = makeSweepEtfConfig(def, {
      id: key,
      name: key,
      smaEnabled: input.smaEnabled,
      smaPeriod,
      smaUpperBuffer: input.smaUpperBuffer ?? getDefaultSmaBuffer(index),
      smaLowerBuffer: input.smaLowerBuffer ?? getDefaultSmaBuffer(index),
      riskOffAsset: input.riskOffAsset ?? DEFAULT_RISK_OFF_ASSET,
    });
    const bucket = byIndex.get(index) ?? [];
    bucket.push({ label: key, config });
    byIndex.set(index, bucket);
  }

  const rows: LetfCompareRow[] = [];
  for (const [index, variants] of byIndex) {
    const warmUpDays = input.smaEnabled ? Math.max(...variants.map((v) => v.config.smaPeriod)) : 0;
    const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);
    const [prices, rates] = await Promise.all([
      loadIndexPrices(index, warmUpStart, endDate),
      loadBorrowRates(warmUpStart, endDate),
    ]);
    if (prices.length < 2) continue;

    let riskOffValuesByAsset;
    let riskOffOpenValuesByAsset;
    if (input.smaEnabled) {
      const assets = Array.from(new Set(variants.map((v) => v.config.riskOffAsset)));
      const raw = await loadRiskOffRawSeriesForAssets(assets, warmUpStart, endDate);
      const aligned = alignRiskOffPriceSeries(prices, raw);
      riskOffValuesByAsset = aligned.closeValuesByAsset;
      riskOffOpenValuesByAsset = aligned.openValuesByAsset;
    }

    const results = await runParallelVariants({
      prices,
      rates,
      windowLength: input.windowLength,
      startDate,
      endDate,
      historyWrap: false,
      variants,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
    });

    for (const { label, simulations } of results) {
      if (simulations.length === 0) continue;
      rows.push({ preset: label, index, ...pctStats(simulations) });
    }
  }

  if (rows.length === 0) throw new McpToolError("No valid rolling windows for these presets and range.");
  return rows.sort((a, b) => b.cagrPct.p50 - a.cagrPct.p50);
}

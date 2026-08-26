// Turn a rolling-window run's per-window points into an agent-friendly
// distribution: percentiles, a histogram, and (opt-in) the raw windows.
//
// The summary rows the sweep tools return (avg / best / worst / win rate) hide
// the shape of the outcome distribution, which for leveraged strategies is the
// part that matters. Percentiles and the histogram are always computed from
// EVERY window; only the raw list is strided when it would be too large to
// return, so the statistics never describe a different sample than the caller
// thinks they do.

import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import { percentile } from "@/lib/strategy-percentiles";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";
import { MAX_RETURNED_WINDOWS } from "@/lib/mcp/limits";

const HISTOGRAM_BINS = 10;

interface PercentileBlock {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

interface WindowRow {
  startDate: string;
  endDate: string;
  cagrPct: number;
  totalReturnPct: number;
  finalMultiple: number;
  maxDrawdownPct: number;
  /** Whether the strategy ended above the unleveraged index over this window. */
  beat1x: boolean;
  trades: number;
}

interface HistogramBin {
  fromCagrPct: number;
  toCagrPct: number;
  count: number;
}

interface WindowDistribution {
  windowCount: number;
  winRateVs1xPct: number;
  percentiles: {
    cagrPct: PercentileBlock;
    totalReturnPct: PercentileBlock;
    maxDrawdownPct: PercentileBlock;
    finalMultiple: PercentileBlock;
  };
  histogram: HistogramBin[];
  /** True when `windows` is a strided sample rather than every window. */
  sampled: boolean;
  sampleStride?: number;
  windows?: WindowRow[];
}

function percentiles(values: number[]): PercentileBlock {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p5: percentile(sorted, 0.05),
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

function buildHistogram(values: number[]): HistogramBin[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A degenerate spread (every window identical) collapses to one bin rather
  // than producing zero-width bins that can't hold anything.
  if (!(max > min)) return [{ fromCagrPct: min, toCagrPct: max, count: values.length }];

  const width = (max - min) / HISTOGRAM_BINS;
  const bins: HistogramBin[] = Array.from({ length: HISTOGRAM_BINS }, (_, i) => ({
    fromCagrPct: min + i * width,
    toCagrPct: i === HISTOGRAM_BINS - 1 ? max : min + (i + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const idx = Math.min(HISTOGRAM_BINS - 1, Math.floor((value - min) / width));
    bins[idx].count += 1;
  }
  return bins;
}

function toWindowRow(point: RollingSimulationPoint): WindowRow {
  return {
    startDate: point.startDate,
    endDate: point.endDate,
    cagrPct: point.cagr,
    totalReturnPct: point.totalReturnPct,
    finalMultiple: point.finalValue / CONSTANT_INITIAL_INVESTMENT,
    maxDrawdownPct: point.maxDrawdownPct,
    beat1x: point.finalValue > point.nonLeveragedFinalValue,
    trades: point.tradeCount,
  };
}

/**
 * Summarize per-window outcomes. `includeWindows` attaches the raw rows, strided
 * down to `maxWindows` when there are more (rolling windows overlap daily, so a
 * long range easily produces thousands).
 */
export function summarizeWindowPoints(
  points: RollingSimulationPoint[],
  options: { includeWindows?: boolean; maxWindows?: number },
): WindowDistribution {
  const maxWindows = options.maxWindows ?? MAX_RETURNED_WINDOWS;
  const cagrs = points.map((p) => p.cagr);
  const wins = points.filter((p) => p.finalValue > p.nonLeveragedFinalValue).length;

  const distribution: WindowDistribution = {
    windowCount: points.length,
    winRateVs1xPct: points.length > 0 ? (wins / points.length) * 100 : 0,
    percentiles: {
      cagrPct: percentiles(cagrs),
      totalReturnPct: percentiles(points.map((p) => p.totalReturnPct)),
      maxDrawdownPct: percentiles(points.map((p) => p.maxDrawdownPct)),
      finalMultiple: percentiles(points.map((p) => p.finalValue / CONSTANT_INITIAL_INVESTMENT)),
    },
    histogram: buildHistogram(cagrs),
    sampled: false,
  };

  if (!options.includeWindows) return distribution;

  if (points.length <= maxWindows) {
    return { ...distribution, windows: points.map(toWindowRow) };
  }

  const stride = Math.ceil(points.length / maxWindows);
  const windows: WindowRow[] = [];
  for (let i = 0; i < points.length; i += stride) windows.push(toWindowRow(points[i]));
  return { ...distribution, sampled: true, sampleStride: stride, windows };
}

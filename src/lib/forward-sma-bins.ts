// Gap-to-SMA binning for forward-return analysis, shared by the raincloud chart
// on the compare page and the `get_forward_sma_returns` MCP tool.
//
// These constants and the bin arithmetic used to live inside
// `ForwardReturnVsSmaGapChart.tsx`. A server-side tool cannot import a
// "use client" component, and a second copy of the bin edges would let the
// chart and the tool answer the same question differently — the drift
// `sweep-items.ts` exists to prevent, in a different shape.

import { percentile } from "@/lib/strategy-percentiles";
import type { ForwardSmaReturnPoint } from "@/lib/simulation/forward-sma-returns";

/** Bin width in percentage points of gap between close and SMA. */
export const FORWARD_GAP_BIN_WIDTH_PCT = 2;

// Bins clipped to [-20%, +26%] so the edge buckets read "≤-18%" / "≥24%"; any
// values past those cutoffs fold into the edge buckets rather than being lost.
export const FORWARD_GAP_BIN_MIN_PCT = -20;
export const FORWARD_GAP_BIN_MAX_PCT = 26;

const FORWARD_GAP_BIN_COUNT = Math.round(
  (FORWARD_GAP_BIN_MAX_PCT - FORWARD_GAP_BIN_MIN_PCT) / FORWARD_GAP_BIN_WIDTH_PCT,
);

export function binIndexForGap(gapPct: number): number {
  const clipped = Math.min(FORWARD_GAP_BIN_MAX_PCT - 1e-9, Math.max(FORWARD_GAP_BIN_MIN_PCT, gapPct));
  return Math.floor((clipped - FORWARD_GAP_BIN_MIN_PCT) / FORWARD_GAP_BIN_WIDTH_PCT);
}

export function binLabelForIndex(idx: number): string {
  const lo = FORWARD_GAP_BIN_MIN_PCT + idx * FORWARD_GAP_BIN_WIDTH_PCT;
  const hi = lo + FORWARD_GAP_BIN_WIDTH_PCT;
  if (idx === 0) return `≤${hi}%`;
  if (lo + FORWARD_GAP_BIN_WIDTH_PCT >= FORWARD_GAP_BIN_MAX_PCT) return `≥${lo}%`;
  return `${lo} to ${hi}%`;
}

/** One array of points per bin, empty bins included, in ascending gap order. */
export function bucketizeForwardPoints(
  points: ForwardSmaReturnPoint[],
): ForwardSmaReturnPoint[][] {
  const buckets: ForwardSmaReturnPoint[][] = Array.from(
    { length: FORWARD_GAP_BIN_COUNT },
    () => [],
  );
  for (const p of points) {
    if (!Number.isFinite(p.realReturnFactor) || p.realReturnFactor <= 0) continue;
    buckets[binIndexForGap(p.gap)].push(p);
  }
  return buckets;
}

export interface ForwardBinSummary {
  label: string;
  fromGapPct: number;
  toGapPct: number;
  count: number;
  /** Forward real returns, in percent, for observations in this gap bin. */
  medianRealReturnPct: number;
  p10RealReturnPct: number;
  p90RealReturnPct: number;
  minRealReturnPct: number;
  maxRealReturnPct: number;
}

const toPct = (factor: number): number => (factor - 1) * 100;

/**
 * Per-bin distribution of the forward real return, for the bins that actually
 * hold observations. A median alone hides how wide each bin is, and the width
 * is the point — deep-below-SMA bins are both higher-mean and far more
 * dispersed than bins near the line.
 */
export function summarizeForwardBins(points: ForwardSmaReturnPoint[]): ForwardBinSummary[] {
  return bucketizeForwardPoints(points).flatMap((bucket, idx) => {
    if (bucket.length === 0) return [];
    const sorted = bucket.map((p) => p.realReturnFactor).sort((a, b) => a - b);
    const lo = FORWARD_GAP_BIN_MIN_PCT + idx * FORWARD_GAP_BIN_WIDTH_PCT;
    return [
      {
        label: binLabelForIndex(idx),
        fromGapPct: lo,
        toGapPct: lo + FORWARD_GAP_BIN_WIDTH_PCT,
        count: bucket.length,
        medianRealReturnPct: toPct(percentile(sorted, 0.5)),
        p10RealReturnPct: toPct(percentile(sorted, 0.1)),
        p90RealReturnPct: toPct(percentile(sorted, 0.9)),
        minRealReturnPct: toPct(sorted[0]),
        maxRealReturnPct: toPct(sorted[sorted.length - 1]),
      },
    ];
  });
}

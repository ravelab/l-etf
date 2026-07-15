import { CONSTANT_INITIAL_INVESTMENT } from "../constants";

interface TradeIndexedDailyValues {
  dailyValues: number[];
  tradeDayIndices?: number[];
  tradeCountPrefix?: Uint32Array;
  tradeValuePrefix?: Float64Array;
}

interface SpreadInputs {
  riskOnSpreadRegular?: number;
  riskOffSpreadRegular?: number;
}

export function getRangeTradeCount(
  precomputed: TradeIndexedDailyValues,
  startIdx: number,
  endIdx: number
): number {
  if (precomputed.tradeCountPrefix) {
    return precomputed.tradeCountPrefix[endIdx + 1] - precomputed.tradeCountPrefix[startIdx];
  }
  if (!precomputed.tradeDayIndices) return 0;

  let count = 0;
  for (const idx of precomputed.tradeDayIndices) {
    if (idx < startIdx) continue;
    if (idx > endIdx) break;
    count += 1;
  }
  return count;
}

export function getRangeTradeValueSum(
  precomputed: TradeIndexedDailyValues,
  startIdx: number,
  endIdx: number
): number {
  if (precomputed.tradeValuePrefix) {
    return precomputed.tradeValuePrefix[endIdx + 1] - precomputed.tradeValuePrefix[startIdx];
  }
  if (!precomputed.tradeDayIndices) return 0;

  let sum = 0;
  for (const idx of precomputed.tradeDayIndices) {
    if (idx < startIdx) continue;
    if (idx > endIdx) break;
    sum += precomputed.dailyValues[idx];
  }
  return sum;
}

export function selectEdgeSpreads(
  spreads: SpreadInputs,
  startInRiskOff: boolean,
  endInRiskOff: boolean
): { entrySpread: number; exitSpread: number } {
  return {
    entrySpread: startInRiskOff ? (spreads.riskOffSpreadRegular ?? 0) : (spreads.riskOnSpreadRegular ?? 0),
    exitSpread: endInRiskOff ? (spreads.riskOffSpreadRegular ?? 0) : (spreads.riskOnSpreadRegular ?? 0),
  };
}

/**
 * Renormalization factor that rebases a value series to start at
 * CONSTANT_INITIAL_INVESTMENT while folding in the entry spread cost paid to
 * establish the position at the window's start. Every simulation path that
 * renormalizes a windowed sub-range must apply entry spread here, at the
 * rebasing step — deducting it later (e.g. only from a reported finalValue)
 * silently renormalizes the cost away.
 */
export function computeEntryAdjustedFactor(firstValue: number, entrySpread: number = 0): number {
  return (CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread)) / firstValue;
}

export function computeRenormalizedPathMetrics(
  values: number[],
  startIdx: number,
  endIdx: number,
  entrySpread: number = 0
): { factor: number; finalValue: number; peak: number; maxDrawdownPct: number } | null {
  if (endIdx - startIdx < 1) return null;

  const firstValue = values[startIdx];
  if (!isFinite(firstValue) || firstValue <= 0) return null;

  const factor = computeEntryAdjustedFactor(firstValue, entrySpread);
  const entryAdjustedInitialValue = CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread);
  let finalValue = entryAdjustedInitialValue;
  let peak = entryAdjustedInitialValue;
  let maxDrawdownPct = 0;

  for (let dayIdx = startIdx; dayIdx <= endIdx; dayIdx += 1) {
    const renormalizedValue = values[dayIdx] * factor;
    if (dayIdx === endIdx) finalValue = renormalizedValue;
    if (renormalizedValue > peak) peak = renormalizedValue;
    const drawdown = peak > 0 ? (peak - renormalizedValue) / peak : 0;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  return { factor, finalValue, peak, maxDrawdownPct };
}

export function computeOptionalNonLeveragedMetrics(
  values: number[] | undefined,
  startIdx: number,
  endIdx: number
): { finalValue: number; peak: number; maxDrawdownPct: number } {
  const metrics = values ? computeRenormalizedPathMetrics(values, startIdx, endIdx) : null;
  return metrics ?? {
    finalValue: CONSTANT_INITIAL_INVESTMENT,
    peak: CONSTANT_INITIAL_INVESTMENT,
    maxDrawdownPct: 0,
  };
}

export function finalizeTradingCosts({
  rawFinalValue,
  entrySpread,
  exitSpread,
  internalDollarCost = 0,
}: {
  rawFinalValue: number;
  entrySpread: number;
  exitSpread: number;
  internalDollarCost?: number;
}): {
  finalValue: number;
  entryDollarCost: number;
  exitDollarCost: number;
  totalDollarCost: number;
  totalTradingCostPct: number;
} {
  const entryDollarCost = CONSTANT_INITIAL_INVESTMENT * entrySpread;
  const exitDollarCost = rawFinalValue * exitSpread;
  const finalValue = Math.max(0, rawFinalValue - exitDollarCost);
  const totalDollarCost = entryDollarCost + internalDollarCost + exitDollarCost;

  return {
    finalValue,
    entryDollarCost,
    exitDollarCost,
    totalDollarCost,
    totalTradingCostPct: finalValue > 0 ? (totalDollarCost / finalValue) * 100 : 0,
  };
}

/**
 * Renormalize a value series so it starts at CONSTANT_INITIAL_INVESTMENT
 * (adjusted for entry spread) at `startIdx`, extending to the end of the
 * array. Shared by any path that slices a longer precomputed series down to
 * a display window's start (e.g. warm-up trimming) — the counterpart to
 * `computeRenormalizedPathMetrics` for callers that need the full rescaled
 * series rather than just its endpoint/peak/drawdown.
 */
export function renormalizeSeriesFromIndex(
  values: number[],
  startIdx: number,
  entrySpread: number = 0
): number[] {
  const slice = values.slice(startIdx);
  if (slice.length === 0) return [];
  const firstValue = slice[0];
  if (!isFinite(firstValue) || firstValue === 0) return slice;
  const factor = computeEntryAdjustedFactor(firstValue, entrySpread);
  return slice.map((v) => v * factor);
}

interface DatedSignal {
  date: string;
  type: "buy" | "sell";
}

/**
 * Resolve the risk-on/risk-off regime in effect at a window's start and end
 * dates from a chronological signal list, falling back to the regime carried
 * in from before the series (e.g. the simulation's true start state) when no
 * signal precedes the cutoff. Shared by every path that needs to pick
 * entry/exit spreads for a date-bounded (rather than index-bounded) window.
 */
export function resolveEdgeRiskOffStates(
  signals: DatedSignal[],
  startDate: string,
  endDate: string,
  carriedInRiskOff: boolean
): { startInRiskOff: boolean; endInRiskOff: boolean } {
  const lastSignalAtOrBefore = (cutoff: string): DatedSignal | undefined => {
    let latest: DatedSignal | undefined;
    for (const s of signals) {
      if (s.date <= cutoff) latest = s;
      else break;
    }
    return latest;
  };

  const startSignal = signals.length > 0 ? lastSignalAtOrBefore(startDate) : undefined;
  const endSignal = signals.length > 0 ? lastSignalAtOrBefore(endDate) : undefined;

  return {
    startInRiskOff: startSignal ? startSignal.type === "sell" : carriedInRiskOff,
    endInRiskOff: endSignal ? endSignal.type === "sell" : carriedInRiskOff,
  };
}

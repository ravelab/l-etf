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

export function computeRenormalizedPathMetrics(
  values: number[],
  startIdx: number,
  endIdx: number
): { factor: number; finalValue: number; peak: number; maxDrawdownPct: number } | null {
  if (endIdx - startIdx < 1) return null;

  const firstValue = values[startIdx];
  if (!isFinite(firstValue) || firstValue <= 0) return null;

  const factor = CONSTANT_INITIAL_INVESTMENT / firstValue;
  let finalValue = CONSTANT_INITIAL_INVESTMENT;
  let peak = CONSTANT_INITIAL_INVESTMENT;
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

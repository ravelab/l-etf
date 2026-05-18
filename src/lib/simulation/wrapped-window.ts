import { simulateSingleEtf } from "./engine";
import { materializeRollingWindow, type RollingSimulationPoint, type RollingWindow } from "./rolling";
import { calcCagr } from "./metrics";
import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import { buildRateLookup } from "./borrowing-rate";
import type { EtfConfig, PricePoint, RatePoint } from "./types";
import { adjustedOpenFromPricePoint } from "../utils";
import {
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  getRangeTradeCount,
  getRangeTradeValueSum,
  selectEdgeSpreads,
} from "./window-calculations";

export interface WrappedPrecomputedConfigDailyValues {
  configId: string;
  dailyValues: number[];
  smaSignals?: Array<{ date: string; type: "buy" | "sell"; price: number }>;
  nonLeveragedValues?: number[];
  perTransitionSpreadFraction?: number;
  tradeDayIndices?: number[];
  tradeCountPrefix?: Uint32Array;
  tradeValuePrefix?: Float64Array;
  riskOnSpread?: number;
  riskOffSpread?: number;
  riskOnSpreadRegular?: number;
  riskOffSpreadRegular?: number;
}

interface WrappedTailCache {
  joinDate: string;
  tailJoinOffset: number;
  tailDates: string[];
  normalizedTailValues: number[];
  normalizedTailNonLeveragedValues: number[];
  smaSignals: Array<{ date: string; type: "buy" | "sell"; price: number }>;
  normalizedValueByDate: Map<string, number>;
}

function findLastDateLte(dates: string[], date: string, lo = 0): number {
  let left = lo;
  let right = dates.length - 1;
  let result = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (dates[mid] <= date) {
      result = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return result;
}

function computeRealWrappedPrefix(
  precomputed: WrappedPrecomputedConfigDailyValues,
  startIdx: number,
  endIdx: number
): {
  realFinalValue: number;
  realNonLeveragedFinalValue: number;
  peak: number;
  maxDrawdownPct: number;
  nonLeveragedPeak: number;
  nonLeveragedMaxDrawdownPct: number;
  internalDollarCost: number;
} | null {
  const realMetrics = computeRenormalizedPathMetrics(precomputed.dailyValues, startIdx, endIdx);
  if (!realMetrics) return null;

  const nonLeveragedMetrics = computeOptionalNonLeveragedMetrics(precomputed.nonLeveragedValues, startIdx, endIdx);
  const spreadFrac = precomputed.perTransitionSpreadFraction ?? 0;
  const internalDollarCost = spreadFrac > 0
    ? realMetrics.factor * spreadFrac * getRangeTradeValueSum(precomputed, startIdx, endIdx)
    : 0;

  return {
    realFinalValue: realMetrics.finalValue,
    realNonLeveragedFinalValue: nonLeveragedMetrics.finalValue,
    peak: realMetrics.peak,
    maxDrawdownPct: realMetrics.maxDrawdownPct,
    nonLeveragedPeak: nonLeveragedMetrics.peak,
    nonLeveragedMaxDrawdownPct: nonLeveragedMetrics.maxDrawdownPct,
    internalDollarCost,
  };
}

export function buildWrappedTailCache(
  windows: RollingWindow[],
  prices: PricePoint[],
  config: EtfConfig,
  rates: RatePoint[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>
): WrappedTailCache | null {
  const wrappedWindows = windows.filter((window) => window.usesSyntheticTail);
  if (wrappedWindows.length === 0) return null;

  const template = wrappedWindows[0];
  const realEndIdx = template.endIdx;
  if (wrappedWindows.some((window) => window.endIdx !== realEndIdx)) {
    return null;
  }
  const maxEndDate = wrappedWindows.reduce(
    (latest, window) => (window.endDate > latest ? window.endDate : latest),
    template.endDate
  );
  const tailWarmUpDays = Math.max(config.smaPeriod, 2);
  const tailStartIdx = Math.max(0, realEndIdx - tailWarmUpDays);
  const tailWindow: RollingWindow = {
    ...template,
    startIdx: tailStartIdx,
    startDate: prices[tailStartIdx].date,
    endDate: maxEndDate,
  };

  const materialized = materializeRollingWindow({
    prices,
    rates,
    window: tailWindow,
    warmUpDays: 0,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
  });
  const tailJoinOffset = realEndIdx - tailStartIdx;
  const tailPrices = materialized.prices;
  if (tailPrices.length < 2 || tailJoinOffset >= tailPrices.length - 1) {
    return null;
  }

  const tailDates = tailPrices.map((price) => price.date);
  const tailReturnClosePrices = tailPrices.map((price) => price.adj_close);
  const tailSmaClosePrices = tailPrices.map((price) => price.close);
  const tailOpenPrices = tailPrices.map(adjustedOpenFromPricePoint);
  const tailIndexReturns = new Array<number>(tailPrices.length);
  tailIndexReturns[0] = 0;
  for (let i = 1; i < tailPrices.length; i++) {
    const prev = tailReturnClosePrices[i - 1];
    const curr = tailReturnClosePrices[i];
    tailIndexReturns[i] = prev > 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
  }

  const rateLookup = buildRateLookup(materialized.rates);
  const tailBorrowingRates = tailDates.map((date) => rateLookup.getRate(date));
  const tailEtfResult = simulateSingleEtf(
    config,
    tailDates,
    tailReturnClosePrices,
    tailIndexReturns,
    tailOpenPrices,
    tailSmaClosePrices,
    tailBorrowingRates,
    materialized.riskOffValuesByAsset,
    materialized.riskOffOpenValuesByAsset
  );

  const tailBaseValue = tailEtfResult.dailyValues[tailJoinOffset];
  if (!isFinite(tailBaseValue) || tailBaseValue <= 0) {
    return null;
  }
  const tailDisplayValues = tailEtfResult.dailyValues.slice(tailJoinOffset);
  if (tailDisplayValues.length === 0) {
    return null;
  }
  const tailFactor = CONSTANT_INITIAL_INVESTMENT / tailBaseValue;
  const normalizedTailValues = tailDisplayValues.map((value) => value * tailFactor);

  const tailNonLeveragedValues = new Array<number>(tailReturnClosePrices.length);
  tailNonLeveragedValues[0] = CONSTANT_INITIAL_INVESTMENT;
  for (let i = 1; i < tailReturnClosePrices.length; i++) {
    const prev = tailReturnClosePrices[i - 1];
    const curr = tailReturnClosePrices[i];
    const dailyReturn = prev > 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
    tailNonLeveragedValues[i] = tailNonLeveragedValues[i - 1] * (1 + dailyReturn);
  }
  const tailNonLeveragedBaseValue = tailNonLeveragedValues[tailJoinOffset];
  if (!isFinite(tailNonLeveragedBaseValue) || tailNonLeveragedBaseValue <= 0) {
    return null;
  }
  const normalizedTailNonLeveragedValues = tailNonLeveragedValues
    .slice(tailJoinOffset)
    .map((value) => value * (CONSTANT_INITIAL_INVESTMENT / tailNonLeveragedBaseValue));

  const displayTailDates = tailDates.slice(tailJoinOffset);
  const normalizedValueByDate = new Map<string, number>();
  for (let i = 0; i < displayTailDates.length; i++) {
    normalizedValueByDate.set(displayTailDates[i], normalizedTailValues[i]);
  }

  return {
    joinDate: prices[realEndIdx].date,
    tailJoinOffset,
    tailDates,
    normalizedTailValues,
    normalizedTailNonLeveragedValues,
    smaSignals: tailEtfResult.smaSignals,
    normalizedValueByDate,
  };
}

export function extractOptimizedWrappedWindowResult(
  precomputed: WrappedPrecomputedConfigDailyValues,
  window: RollingWindow,
  prices: PricePoint[],
  config: EtfConfig,
  rates: RatePoint[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>
): RollingSimulationPoint | null {
  const actualWindowStart = window.startIdx;
  const realEndIdx = window.endIdx;
  const realWindowLength = realEndIdx - actualWindowStart + 1;
  if (realWindowLength < 2) return null;

  const realPrefix = computeRealWrappedPrefix(precomputed, actualWindowStart, realEndIdx);
  if (!realPrefix) return null;

  const realFinalValue = realPrefix.realFinalValue;
  let peak = realPrefix.peak;
  let maxDrawdownPct = realPrefix.maxDrawdownPct;
  const internalDollarCost = realPrefix.internalDollarCost;
  const spreadFrac = precomputed.perTransitionSpreadFraction ?? 0;
  const realNonLeveragedFinalValue = realPrefix.realNonLeveragedFinalValue;
  let nonLeveragedPeak = realPrefix.nonLeveragedPeak;
  let nonLeveragedMaxDrawdownPct = realPrefix.nonLeveragedMaxDrawdownPct;

  const joinDate = prices[realEndIdx].date;
  const tailWarmUpDays = Math.max(config.smaPeriod, 2);
  const tailStartIdx = Math.max(0, realEndIdx - tailWarmUpDays);
  const tailWindow: RollingWindow = {
    ...window,
    startIdx: tailStartIdx,
    startDate: prices[tailStartIdx].date,
  };

  const materialized = materializeRollingWindow({
    prices,
    rates,
    window: tailWindow,
    warmUpDays: 0,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
  });
  const tailJoinOffset = realEndIdx - tailStartIdx;
  const tailPrices = materialized.prices;
  if (tailPrices.length < 2 || tailJoinOffset >= tailPrices.length - 1) {
    return null;
  }
  const tailDates = tailPrices.map((price) => price.date);
  const tailReturnClosePrices = tailPrices.map((price) => price.adj_close);
  const tailSmaClosePrices = tailPrices.map((price) => price.close);
  const tailOpenPrices = tailPrices.map(adjustedOpenFromPricePoint);
  const tailIndexReturns = new Array<number>(tailPrices.length);
  tailIndexReturns[0] = 0;
  for (let i = 1; i < tailPrices.length; i++) {
    const prev = tailReturnClosePrices[i - 1];
    const curr = tailReturnClosePrices[i];
    tailIndexReturns[i] = prev > 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
  }
  const rateLookup = buildRateLookup(materialized.rates);
  const tailBorrowingRates = tailDates.map((date) => rateLookup.getRate(date));
  const tailEtfResult = simulateSingleEtf(
    config,
    tailDates,
    tailReturnClosePrices,
    tailIndexReturns,
    tailOpenPrices,
    tailSmaClosePrices,
    tailBorrowingRates,
    materialized.riskOffValuesByAsset,
    materialized.riskOffOpenValuesByAsset
  );
  const tailBaseValue = tailEtfResult.dailyValues[tailJoinOffset];
  if (!isFinite(tailBaseValue) || tailBaseValue <= 0) {
    return null;
  }
  const tailDisplayValues = tailEtfResult.dailyValues.slice(tailJoinOffset);
  if (tailDisplayValues.length === 0) {
    return null;
  }
  const tailFactor = CONSTANT_INITIAL_INVESTMENT / tailBaseValue;
  const normalizedTailValues = tailDisplayValues.map((value) => value * tailFactor);
  const tailNonLeveragedValues = new Array<number>(tailReturnClosePrices.length);
  tailNonLeveragedValues[0] = CONSTANT_INITIAL_INVESTMENT;
  for (let i = 1; i < tailReturnClosePrices.length; i++) {
    const prev = tailReturnClosePrices[i - 1];
    const curr = tailReturnClosePrices[i];
    const dailyReturn = prev > 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
    tailNonLeveragedValues[i] = tailNonLeveragedValues[i - 1] * (1 + dailyReturn);
  }
  const tailNonLeveragedBaseValue = tailNonLeveragedValues[tailJoinOffset];
  if (!isFinite(tailNonLeveragedBaseValue) || tailNonLeveragedBaseValue <= 0) {
    return null;
  }
  const normalizedTailNonLeveragedValues = tailNonLeveragedValues
    .slice(tailJoinOffset)
    .map((value) => value * (CONSTANT_INITIAL_INVESTMENT / tailNonLeveragedBaseValue));

  const tailJoinValue = normalizedTailValues[0];
  const tailJoinNonLeveragedValue = normalizedTailNonLeveragedValues[0];
  if (!isFinite(tailJoinValue) || tailJoinValue <= 0 || !isFinite(tailJoinNonLeveragedValue) || tailJoinNonLeveragedValue <= 0) {
    return null;
  }

  const tailScale = realFinalValue / tailJoinValue;
  const tailNonLeveragedScale = realNonLeveragedFinalValue / tailJoinNonLeveragedValue;
  const scaledTailValues = normalizedTailValues.map((value) => value * tailScale);
  const scaledTailNonLeveragedValues = normalizedTailNonLeveragedValues.map((value) => value * tailNonLeveragedScale);

  for (let i = 1; i < scaledTailValues.length; i++) {
    const value = scaledTailValues[i];
    if (value > peak) peak = value;
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  for (let i = 1; i < scaledTailNonLeveragedValues.length; i++) {
    const value = scaledTailNonLeveragedValues[i];
    if (value > nonLeveragedPeak) nonLeveragedPeak = value;
    const drawdown = (nonLeveragedPeak - value) / nonLeveragedPeak;
    if (drawdown > nonLeveragedMaxDrawdownPct) nonLeveragedMaxDrawdownPct = drawdown;
  }

  const scaledTailDateToValue = new Map<string, number>();
  const displayTailDates = tailDates.slice(tailJoinOffset);
  for (let i = 0; i < displayTailDates.length; i++) {
    scaledTailDateToValue.set(displayTailDates[i], scaledTailValues[i]);
  }

  const tailTradeCount = tailEtfResult.smaSignals.filter((signal) => signal.date > joinDate).length;
  let tailInternalDollarCost = 0;
  if (spreadFrac > 0) {
    for (const signal of tailEtfResult.smaSignals) {
      if (signal.date <= joinDate) continue;
      const value = scaledTailDateToValue.get(signal.date);
      if (value && isFinite(value)) {
        tailInternalDollarCost += value * spreadFrac;
      }
    }
  }

  const isSma = precomputed.smaSignals !== undefined && precomputed.smaSignals.length > 0;
  const startInRiskOff = isSma && precomputed.smaSignals!.some(s => s.date <= window.startDate) && 
    [...precomputed.smaSignals!].reverse().find(s => s.date <= window.startDate)?.type === 'sell';
  const endInRiskOff = tailEtfResult.smaSignals.length > 0 && 
    [...tailEtfResult.smaSignals].reverse().find(s => s.date <= window.endDate)?.type === 'sell';

  const { entrySpread, exitSpread } = selectEdgeSpreads(precomputed, startInRiskOff, endInRiskOff);
  
  const rawFinalValue = scaledTailValues[scaledTailValues.length - 1] ?? realFinalValue;
  const tradingCosts = finalizeTradingCosts({
    rawFinalValue,
    entrySpread,
    exitSpread,
    internalDollarCost: internalDollarCost + tailInternalDollarCost,
  });
  const finalValue = tradingCosts.finalValue;

  const realTradeCount = getRangeTradeCount(precomputed, actualWindowStart, realEndIdx);
  const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, window.startDate, window.endDate);

  return {
    startDate: window.startDate,
    endDate: window.endDate,
    finalValue,
    nonLeveragedFinalValue: scaledTailNonLeveragedValues[scaledTailNonLeveragedValues.length - 1] ?? realNonLeveragedFinalValue,
    maxDrawdownPct: maxDrawdownPct * 100,
    nonLeveragedMaxDrawdownPct: nonLeveragedMaxDrawdownPct * 100,
    cagr,
    totalReturnPct: ((finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    tradeCount: realTradeCount + tailTradeCount,
    totalTradingCostPct: tradingCosts.totalTradingCostPct,
    usedHistoryWrap: true,
  };
}

export function extractCachedWrappedWindowResult(
  precomputed: WrappedPrecomputedConfigDailyValues,
  window: RollingWindow,
  prices: PricePoint[],
  cache: WrappedTailCache
): RollingSimulationPoint | null {
  const actualWindowStart = window.startIdx;
  const realEndIdx = window.endIdx;
  const realWindowLength = realEndIdx - actualWindowStart + 1;
  if (realWindowLength < 2) return null;

  const realPrefix = computeRealWrappedPrefix(precomputed, actualWindowStart, realEndIdx);
  if (!realPrefix) return null;

  const realFinalValue = realPrefix.realFinalValue;
  let peak = realPrefix.peak;
  let maxDrawdownPct = realPrefix.maxDrawdownPct;
  const internalDollarCost = realPrefix.internalDollarCost;
  const spreadFrac = precomputed.perTransitionSpreadFraction ?? 0;
  const realNonLeveragedFinalValue = realPrefix.realNonLeveragedFinalValue;
  let nonLeveragedPeak = realPrefix.nonLeveragedPeak;
  let nonLeveragedMaxDrawdownPct = realPrefix.nonLeveragedMaxDrawdownPct;

  const tailEndOffset = findLastDateLte(cache.tailDates, window.endDate, cache.tailJoinOffset);
  if (tailEndOffset <= cache.tailJoinOffset) return null;
  const tailDisplayEndIdx = tailEndOffset - cache.tailJoinOffset;

  const tailJoinValue = cache.normalizedTailValues[0];
  const tailJoinNonLeveragedValue = cache.normalizedTailNonLeveragedValues[0];
  if (!isFinite(tailJoinValue) || tailJoinValue <= 0 || !isFinite(tailJoinNonLeveragedValue) || tailJoinNonLeveragedValue <= 0) {
    return null;
  }

  const tailScale = realFinalValue / tailJoinValue;
  const tailNonLeveragedScale = realNonLeveragedFinalValue / tailJoinNonLeveragedValue;

  for (let i = 1; i <= tailDisplayEndIdx; i++) {
    const value = cache.normalizedTailValues[i] * tailScale;
    if (value > peak) peak = value;
    const drawdown = (peak - value) / peak;
    if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
  }

  for (let i = 1; i <= tailDisplayEndIdx; i++) {
    const value = cache.normalizedTailNonLeveragedValues[i] * tailNonLeveragedScale;
    if (value > nonLeveragedPeak) nonLeveragedPeak = value;
    const drawdown = (nonLeveragedPeak - value) / nonLeveragedPeak;
    if (drawdown > nonLeveragedMaxDrawdownPct) {
      nonLeveragedMaxDrawdownPct = drawdown;
    }
  }

  const tailTradeCount = cache.smaSignals.filter((signal) => signal.date > cache.joinDate && signal.date <= window.endDate).length;
  let tailInternalDollarCost = 0;
  if (spreadFrac > 0) {
    for (const signal of cache.smaSignals) {
      if (signal.date <= cache.joinDate || signal.date > window.endDate) continue;
      const normalizedValue = cache.normalizedValueByDate.get(signal.date);
      if (normalizedValue && isFinite(normalizedValue)) {
        tailInternalDollarCost += normalizedValue * tailScale * spreadFrac;
      }
    }
  }

  const isSma = precomputed.smaSignals !== undefined && precomputed.smaSignals.length > 0;
  const startInRiskOff = isSma && precomputed.smaSignals!.some(s => s.date <= window.startDate) &&
    [...precomputed.smaSignals!].reverse().find(s => s.date <= window.startDate)?.type === 'sell';
  const endInRiskOff = cache.smaSignals.length > 0 &&
    [...cache.smaSignals].reverse().find(s => s.date <= window.endDate)?.type === 'sell';

  const { entrySpread, exitSpread } = selectEdgeSpreads(precomputed, startInRiskOff, endInRiskOff);

  const rawFinalValue = (cache.normalizedTailValues[tailDisplayEndIdx] * tailScale) || realFinalValue;
  const tradingCosts = finalizeTradingCosts({
    rawFinalValue,
    entrySpread,
    exitSpread,
    internalDollarCost: internalDollarCost + tailInternalDollarCost,
  });
  const finalValue = tradingCosts.finalValue;

  const realTradeCount = getRangeTradeCount(precomputed, actualWindowStart, realEndIdx);
  const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, window.startDate, window.endDate);

  return {
    startDate: window.startDate,
    endDate: window.endDate,
    finalValue,
    nonLeveragedFinalValue: (cache.normalizedTailNonLeveragedValues[tailDisplayEndIdx] * tailNonLeveragedScale) || realNonLeveragedFinalValue,
    maxDrawdownPct: maxDrawdownPct * 100,
    nonLeveragedMaxDrawdownPct: nonLeveragedMaxDrawdownPct * 100,
    cagr,
    totalReturnPct: ((finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    tradeCount: realTradeCount + tailTradeCount,
    totalTradingCostPct: tradingCosts.totalTradingCostPct,
    usedHistoryWrap: true,
  };
}

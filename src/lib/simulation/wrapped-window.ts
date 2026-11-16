import { simulateSingleEtf } from "./single-etf";
import { materializeRollingWindow, type RollingSimulationPoint, type RollingWindow } from "./rolling";
import { calcCagr } from "./metrics";
import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import { buildRateLookup } from "./borrowing-rate";
import type { EtfConfig, PricePoint, RatePoint } from "./types";
import type { FuturesTaxRates } from "./futures-tax";
import {
  afterTaxPathResult,
  afterTaxWindowResult,
  buildTaxCalendar,
  taxesApply,
  withAfterTaxWindow,
  type TaxCalendar,
} from "./after-tax-window";
import { buildDrawdownRangeQuery, type DrawdownRangeQuery } from "./drawdown-range";
import { adjustedOpenFromPricePoint } from "../utils";
import {
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  countRiskOffDays,
  finalizeTradingCosts,
  getRangeRiskOffDays,
  getRangeTradeCount,
  getRangeTradeValueSum,
  riskOffPercent,
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
  riskOffDayPrefix?: Uint32Array;
  riskOnSpread?: number;
  riskOffSpread?: number;
  riskOnSpreadRegular?: number;
  riskOffSpreadRegular?: number;
}

interface WrappedTailCache {
  joinDate: string;
  initialInvested: boolean;
  tailJoinOffset: number;
  tailDates: string[];
  normalizedTailValues: number[];
  normalizedTailNonLeveragedValues: number[];
  smaSignals: Array<{ date: string; type: "buy" | "sell"; price: number }>;
  normalizedValueByDate: Map<string, number>;
}

/**
 * Whether a simulation was invested (risk-on) as of `date`, given its signal
 * list and the invested state it started from. `defaultInvested` matters when
 * no signal has fired by `date`: a fresh (unseeded) simulation defaults to
 * risk-on, but the wrapped tail is seeded from the real regime at the join —
 * if it never crosses a buffer band, there's no signal to find, and the
 * state must fall back to that seed rather than always assuming risk-on.
 */
function isInvestedAtDate(
  signals: Array<{ date: string; type: "buy" | "sell"; price: number }> | undefined,
  date: string,
  defaultInvested = true
): boolean {
  if (!signals || signals.length === 0) return defaultInvested;
  const last = [...signals].reverse().find((s) => s.date <= date);
  return last ? last.type === "buy" : defaultInvested;
}

/** Regime after each date's close, from the signals on or before it. */
function riskOnAtCloses(
  signals: Array<{ date: string; type: "buy" | "sell" }> | undefined,
  dates: readonly string[],
  initialInvested = true,
): boolean[] {
  let invested = initialInvested;
  let cursor = 0;
  const ordered = signals ?? [];
  return dates.map((date) => {
    while (cursor < ordered.length && ordered[cursor].date <= date) {
      invested = ordered[cursor].type === "buy";
      cursor += 1;
    }
    return invested;
  });
}

/**
 * The regime each session of a path holds: the previous close's, as the engine
 * trades at the next open. The first session holds the close before the path.
 */
function heldRiskOnFromCloses(atClose: readonly boolean[], openingRiskOn: boolean): boolean[] {
  return atClose.map((_, day) => (day === 0 ? openingRiskOn : atClose[day - 1]));
}

/** Regime after the close before `day`; the default when the path starts the data. */
function riskOnBefore(
  signals: Array<{ date: string; type: "buy" | "sell" }> | undefined,
  prices: PricePoint[],
  day: number
): boolean {
  return day > 0 ? riskOnAtCloses(signals, [prices[day - 1].date])[0] : true;
}

/**
 * A history-wrap window taxed as one path: the real prefix from its first close,
 * then the synthetic tail, both in the window's own dollars. Each session holds the
 * previous close's regime, as the engine trades at the next open.
 */
function taxWrappedWindow(
  point: RollingSimulationPoint,
  params: {
    precomputed: WrappedPrecomputedConfigDailyValues;
    prices: PricePoint[];
    startIdx: number;
    realEndIdx: number;
    entrySpread: number;
    /** Tail dates and dollar values from the join day, which the prefix already holds. */
    tailDates: readonly string[];
    tailValues: readonly number[];
    tailSignals: Array<{ date: string; type: "buy" | "sell" }> | undefined;
    tailInitialInvested: boolean;
    exitFraction: number;
  },
  rates: FuturesTaxRates | undefined
): RollingSimulationPoint {
  if (!taxesApply(rates)) return point;
  const { precomputed, prices, startIdx, realEndIdx, entrySpread } = params;
  const factor = (CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread)) / precomputed.dailyValues[startIdx];
  const prefixDates = prices.slice(startIdx, realEndIdx + 1).map((price) => price.date);
  const tailDates = params.tailDates.slice(1);
  const atClose = [
    ...riskOnAtCloses(precomputed.smaSignals, prefixDates),
    ...riskOnAtCloses(params.tailSignals, tailDates, params.tailInitialInvested),
  ];
  const afterTax = afterTaxPathResult({
    dates: [...prefixDates, ...tailDates],
    values: [
      ...precomputed.dailyValues.slice(startIdx, realEndIdx + 1).map((value) => value * factor),
      ...params.tailValues.slice(1),
    ],
    heldRiskOn: heldRiskOnFromCloses(atClose, riskOnBefore(precomputed.smaSignals, prices, startIdx)),
    exitFraction: params.exitFraction,
    rates,
  });
  return withAfterTaxWindow(point, afterTax, rates);
}

/**
 * A config's real history continued by its history-wrap tail, as one path. Every
 * wrapped window of the config is a span of it: the tail is joined at the same
 * close for all of them and scaled to continue from the window's own value there,
 * so in raw units it extends the series the same way each time. Its tax calendar
 * and drawdown tree are therefore built once, and each window is taxed from its
 * own events like a regular one, instead of rebuilding its stitched path.
 */
interface ExtendedTaxPath {
  /** Source day the path starts at (the first wrapped window's start); its days count from here. */
  firstDay: number;
  joinDay: number;
  calendar: TaxCalendar;
  raw: number[];
  stats: DrawdownRangeQuery;
}

const extendedTaxPaths = new WeakMap<WrappedTailCache, ExtendedTaxPath | null>();

function extendedTaxPath(
  precomputed: WrappedPrecomputedConfigDailyValues,
  prices: PricePoint[],
  cache: WrappedTailCache,
  /** The first wrapped window's start: windows come in start order, so the rest start later. */
  firstDay: number
): ExtendedTaxPath | null {
  const cached = extendedTaxPaths.get(cache);
  if (cached !== undefined) return cached;
  const priceDates = prices.map((price) => price.date);
  const joinDay = findLastDateLte(priceDates, cache.joinDate);
  const tailJoinValue = cache.normalizedTailValues[0];
  const built = joinDay >= firstDay && priceDates[joinDay] === cache.joinDate && tailJoinValue > 0
    ? (() => {
        const tailCount = cache.tailDates.length - cache.tailJoinOffset - 1;
        const dates = [...priceDates.slice(firstDay, joinDay + 1), ...cache.tailDates.slice(cache.tailJoinOffset + 1)];
        const prefixLength = joinDay - firstDay + 1;
        const joinValue = precomputed.dailyValues[joinDay];
        const raw = [
          ...precomputed.dailyValues.slice(firstDay, joinDay + 1),
          ...Array.from({ length: tailCount }, (_, i) => joinValue * (cache.normalizedTailValues[i + 1] / tailJoinValue)),
        ];
        // Signals before the first day still set the regime it opens in.
        const atClose = [
          ...riskOnAtCloses(precomputed.smaSignals, dates.slice(0, prefixLength)),
          ...riskOnAtCloses(cache.smaSignals, dates.slice(prefixLength), cache.initialInvested),
        ];
        const held = heldRiskOnFromCloses(atClose, riskOnBefore(precomputed.smaSignals, prices, firstDay));
        return {
          firstDay,
          joinDay,
          calendar: buildTaxCalendar(dates, (day) => held[day]),
          raw,
          stats: buildDrawdownRangeQuery(raw),
        };
      })()
    : null;
  extendedTaxPaths.set(cache, built);
  return built;
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
  endIdx: number,
  entrySpread: number
): {
  realFinalValue: number;
  realNonLeveragedFinalValue: number;
  peak: number;
  maxDrawdownPct: number;
  nonLeveragedPeak: number;
  nonLeveragedMaxDrawdownPct: number;
  internalDollarCost: number;
} | null {
  const realMetrics = computeRenormalizedPathMetrics(precomputed.dailyValues, startIdx, endIdx, entrySpread);
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
  precomputed: WrappedPrecomputedConfigDailyValues,
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
  const joinDate = prices[realEndIdx].date;
  const initialInvested = isInvestedAtDate(precomputed.smaSignals, joinDate);
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
    materialized.riskOffOpenValuesByAsset,
    undefined,
    undefined,
    undefined,
    { smaInitialInvested: initialInvested, smaSeedAtIndex: tailJoinOffset }
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
    joinDate,
    initialInvested,
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
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  taxRates?: FuturesTaxRates,
): RollingSimulationPoint | null {
  const actualWindowStart = window.startIdx;
  const realEndIdx = window.endIdx;
  const realWindowLength = realEndIdx - actualWindowStart + 1;
  if (realWindowLength < 2) return null;

  // Regime at the window's start only depends on precomputed signals, not the
  // synthetic tail — resolve it early so the entry spread can be folded into
  // the real-prefix renormalization instead of only reported afterward.
  const startInRiskOff = !isInvestedAtDate(precomputed.smaSignals, window.startDate);
  const { entrySpread } = selectEdgeSpreads(precomputed, startInRiskOff, startInRiskOff);

  const realPrefix = computeRealWrappedPrefix(precomputed, actualWindowStart, realEndIdx, entrySpread);
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
  const initialInvested = isInvestedAtDate(precomputed.smaSignals, joinDate);
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
    materialized.riskOffOpenValuesByAsset,
    undefined,
    undefined,
    undefined,
    { smaInitialInvested: initialInvested, smaSeedAtIndex: tailJoinOffset }
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

  // The tail was seeded from `initialInvested`, so when it never crosses a
  // buffer band (no signal in `tailEtfResult.smaSignals`), the regime at
  // window.endDate is that seed, not a default risk-on assumption.
  const endInRiskOff = !isInvestedAtDate(tailEtfResult.smaSignals, window.endDate, initialInvested);

  const { exitSpread } = selectEdgeSpreads(precomputed, startInRiskOff, endInRiskOff);
  
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
  const tailEndIdx = tailDates.length - 1;
  const riskOffDays = getRangeRiskOffDays(precomputed, actualWindowStart, realEndIdx)
    + countRiskOffDays(tailDates, tailEtfResult.smaSignals, tailJoinOffset, tailEndIdx, initialInvested);
  const totalDays = (realEndIdx - actualWindowStart) + (tailEndIdx - tailJoinOffset);
  const point: RollingSimulationPoint = {
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
    riskOffPct: riskOffPercent(riskOffDays, totalDays),
    usedHistoryWrap: true,
  };
  return taxWrappedWindow(point, {
    precomputed,
    prices,
    startIdx: actualWindowStart,
    realEndIdx,
    entrySpread,
    tailDates: displayTailDates,
    tailValues: scaledTailValues,
    tailSignals: tailEtfResult.smaSignals,
    tailInitialInvested: initialInvested,
    exitFraction: rawFinalValue > 0 ? finalValue / rawFinalValue : 1,
  }, taxRates);
}

export function extractCachedWrappedWindowResult(
  precomputed: WrappedPrecomputedConfigDailyValues,
  window: RollingWindow,
  prices: PricePoint[],
  cache: WrappedTailCache,
  taxRates?: FuturesTaxRates,
): RollingSimulationPoint | null {
  const actualWindowStart = window.startIdx;
  const realEndIdx = window.endIdx;
  const realWindowLength = realEndIdx - actualWindowStart + 1;
  if (realWindowLength < 2) return null;

  // Regime at the window's start only depends on precomputed signals, not the
  // synthetic tail — resolve it early so the entry spread can be folded into
  // the real-prefix renormalization instead of only reported afterward.
  const startInRiskOff = !isInvestedAtDate(precomputed.smaSignals, window.startDate);
  const { entrySpread } = selectEdgeSpreads(precomputed, startInRiskOff, startInRiskOff);

  const realPrefix = computeRealWrappedPrefix(precomputed, actualWindowStart, realEndIdx, entrySpread);
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

  // Mirrors extractOptimizedWrappedWindowResult: fall back to the tail's seed
  // regime (cache.initialInvested), not a default risk-on assumption, when no
  // cached signal fires before window.endDate.
  const endInRiskOff = !isInvestedAtDate(cache.smaSignals, window.endDate, cache.initialInvested);

  const { exitSpread } = selectEdgeSpreads(precomputed, startInRiskOff, endInRiskOff);

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
  const riskOffDays = getRangeRiskOffDays(precomputed, actualWindowStart, realEndIdx)
    + countRiskOffDays(cache.tailDates, cache.smaSignals, cache.tailJoinOffset, tailEndOffset, cache.initialInvested);
  const totalDays = (realEndIdx - actualWindowStart) + (tailEndOffset - cache.tailJoinOffset);
  const point: RollingSimulationPoint = {
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
    riskOffPct: riskOffPercent(riskOffDays, totalDays),
    usedHistoryWrap: true,
  };
  if (!taxesApply(taxRates)) return point;
  const extended = extendedTaxPath(precomputed, prices, cache, actualWindowStart);
  if (!extended || extended.joinDay !== realEndIdx || actualWindowStart < extended.firstDay) {
    return taxWrappedWindow(point, {
      precomputed,
      prices,
      startIdx: actualWindowStart,
      realEndIdx,
      entrySpread,
      tailDates: cache.tailDates.slice(cache.tailJoinOffset, tailEndOffset + 1),
      tailValues: cache.normalizedTailValues.slice(0, tailDisplayEndIdx + 1).map((value) => value * tailScale),
      tailSignals: cache.smaSignals,
      tailInitialInvested: cache.initialInvested,
      exitFraction: rawFinalValue > 0 ? finalValue / rawFinalValue : 1,
    }, taxRates);
  }
  const afterTax = afterTaxWindowResult({
    calendar: extended.calendar,
    startDay: actualWindowStart - extended.firstDay,
    endDay: realEndIdx - extended.firstDay + tailDisplayEndIdx,
    raw: extended.raw,
    scale: (CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread)) / extended.raw[actualWindowStart - extended.firstDay],
    exitFraction: rawFinalValue > 0 ? finalValue / rawFinalValue : 1,
    rates: taxRates,
    stats: extended.stats,
  });
  return withAfterTaxWindow(point, afterTax, taxRates);
}

// One rolling window's result, sliced from a config's precomputed full-history
// daily values. Worker-safe: no simulation, no Worker construction, so both the
// main thread (`simulation-buckets.ts`) and the Web Worker (`worker.ts`) import
// this one implementation instead of maintaining a mirrored copy.

import type { RollingSimulationPoint, RollingWindow } from "./rolling";
import { calcCagr } from "./metrics";
import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import type { FuturesTaxRates } from "./futures-tax";
import { afterTaxWindowResult, buildTaxCalendar, taxesApply, withAfterTaxWindow, type TaxCalendar } from "./after-tax-window";
import { buildDrawdownRangeQuery, type DrawdownRangeQuery } from "./drawdown-range";
import {
  computeRenormalizedEndpointMetrics,
  finalizeTradingCosts,
  getRangeRiskOffDays,
  getRangeTradeCount,
  getRangeTradeValueSum,
  riskOffPercent,
  selectEdgeSpreads,
} from "./window-calculations";

/** The fields of a precomputed config that window extraction reads. Structured-clone friendly. */
export interface WindowSource {
  dailyValues: number[];
  nonLeveragedValues?: number[];
  timestamps: number[];
  riskOffStateByIndex?: Int8Array;
  /** Prefix count of risk-off days for O(1) window shares. Length = n + 1. */
  riskOffDayPrefix?: Uint32Array;
  /** Raw spread fraction (not percentage) for dollar cost computation */
  perTransitionSpreadFraction?: number;
  /** Sorted indices where a trade occurs. */
  tradeDayIndices?: number[];
  /** Prefix sum of trade counts for O(1) window counts. Length = n + 1. */
  tradeCountPrefix?: Uint32Array;
  /** Prefix sum of daily values at trade points for O(1) spread-cost lookup. */
  tradeValuePrefix?: Float64Array;
  /** Regular-hours half-spread for risk-on asset */
  riskOnSpreadRegular?: number;
  /** Regular-hours half-spread for risk-off asset */
  riskOffSpreadRegular?: number;
}

/**
 * Prebuilt O(log n) range-drawdown queries for a config's value series, so a
 * rolling sweep does not walk every window end to end.
 */
interface WindowDrawdownRanges {
  dailyValues: DrawdownRangeQuery;
  nonLeveragedValues?: DrawdownRangeQuery;
  /** The config's tax calendar, built on the first taxed window and shared by the rest. */
  taxCalendar: () => TaxCalendar;
}

function isRiskOffAt(source: WindowSource, index: number): boolean {
  return source.riskOffStateByIndex?.[index] === 1;
}

/**
 * One tree per config amortises max-drawdown across all its windows:
 * O(n) to build, then O(log n) per window instead of an O(window) walk.
 */
export function buildWindowDrawdownRanges(source: WindowSource): WindowDrawdownRanges {
  let taxCalendar: TaxCalendar | undefined;
  return {
    dailyValues: buildDrawdownRangeQuery(source.dailyValues),
    nonLeveragedValues: source.nonLeveragedValues
      ? buildDrawdownRangeQuery(source.nonLeveragedValues)
      : undefined,
    taxCalendar: () => {
      taxCalendar ??= buildSourceTaxCalendar(source);
      return taxCalendar;
    },
  };
}

/**
 * `riskOffStateByIndex` is the regime after each day's close; the position a
 * session holds is the previous close's, as the engine trades at the next open.
 */
const sourceTaxCalendars = new WeakMap<WindowSource, TaxCalendar>();

function buildSourceTaxCalendar(source: WindowSource): TaxCalendar {
  // Kept per config across calls: win rates bucket the same configs for every holding period.
  const cached = sourceTaxCalendars.get(source);
  if (cached) return cached;
  const dates = source.timestamps.map((timestamp) => new Date(timestamp).toISOString().slice(0, 10));
  const calendar = buildTaxCalendar(dates, (day) => !isRiskOffAt(source, Math.max(0, day - 1)));
  sourceTaxCalendars.set(source, calendar);
  return calendar;
}

/** The 1x index's final value and max drawdown (%) over the window; flat when there is no 1x series. */
function nonLeveragedWindowMetrics(
  source: WindowSource,
  ranges: WindowDrawdownRanges,
  startIdx: number,
  endIdx: number
): { finalValue: number; maxDrawdownPct: number } {
  const values = source.nonLeveragedValues;
  const range = ranges.nonLeveragedValues;
  if (!values || !range) return { finalValue: CONSTANT_INITIAL_INVESTMENT, maxDrawdownPct: 0 };
  return {
    finalValue: computeRenormalizedEndpointMetrics(values, startIdx, endIdx)?.finalValue ?? CONSTANT_INITIAL_INVESTMENT,
    maxDrawdownPct: range(startIdx, endIdx).pct,
  };
}

/**
 * The window entered at its first close and liquidated at its last: entry and
 * exit spreads follow the regime held on each edge, the entry spread is folded
 * into the renormalization (see window-calculations.ts), and trades inside the
 * window are charged from prefix sums. Null when the window cannot be valued
 * (a wiped-out path, or fewer than two days).
 */
export function extractRegularWindowSimulation(
  source: WindowSource,
  window: RollingWindow,
  ranges: WindowDrawdownRanges,
  taxRates?: FuturesTaxRates,
): RollingSimulationPoint | null {
  const { startIdx, endIdx } = window;
  const { entrySpread, exitSpread } = selectEdgeSpreads(
    source,
    isRiskOffAt(source, startIdx),
    isRiskOffAt(source, endIdx)
  );
  const metrics = computeRenormalizedEndpointMetrics(source.dailyValues, startIdx, endIdx, entrySpread);
  if (!metrics || !isFinite(metrics.finalValue)) return null;

  const spreadFrac = source.perTransitionSpreadFraction ?? 0;
  const internalDollarCost = spreadFrac > 0
    ? metrics.factor * spreadFrac * getRangeTradeValueSum(source, startIdx, endIdx)
    : 0;
  const tradingCosts = finalizeTradingCosts({
    rawFinalValue: metrics.finalValue,
    entrySpread,
    exitSpread,
    internalDollarCost,
  });
  const cagr = calcCagr(
    CONSTANT_INITIAL_INVESTMENT,
    tradingCosts.finalValue,
    source.timestamps[startIdx],
    source.timestamps[endIdx],
    window.startDate,
    window.endDate
  );
  const nonLeveraged = nonLeveragedWindowMetrics(source, ranges, startIdx, endIdx);
  const point: RollingSimulationPoint = {
    startDate: window.startDate,
    endDate: window.endDate,
    finalValue: tradingCosts.finalValue,
    nonLeveragedFinalValue: nonLeveraged.finalValue,
    maxDrawdownPct: ranges.dailyValues(startIdx, endIdx).pct,
    nonLeveragedMaxDrawdownPct: nonLeveraged.maxDrawdownPct,
    cagr,
    totalReturnPct: ((tradingCosts.finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    tradeCount: getRangeTradeCount(source, startIdx, endIdx),
    totalTradingCostPct: tradingCosts.totalTradingCostPct,
    riskOffPct: riskOffPercent(getRangeRiskOffDays(source, startIdx, endIdx), endIdx - startIdx),
    usedHistoryWrap: false,
  };
  if (!taxesApply(taxRates)) return point;
  const afterTax = afterTaxWindowResult({
    calendar: ranges.taxCalendar(),
    startDay: startIdx,
    endDay: endIdx,
    raw: source.dailyValues,
    scale: metrics.factor,
    exitFraction: metrics.finalValue > 0 ? tradingCosts.finalValue / metrics.finalValue : 1,
    rates: taxRates,
    stats: ranges.dailyValues,
  });
  return withAfterTaxWindow(point, afterTax, taxRates);
}

/** Every window of one config that can be valued, in window order. */
export function extractRegularWindowSimulations(
  source: WindowSource,
  windows: RollingWindow[],
  taxRates?: FuturesTaxRates,
): RollingSimulationPoint[] {
  const ranges = buildWindowDrawdownRanges(source);
  const simulations: RollingSimulationPoint[] = [];
  for (const window of windows) {
    const simulation = extractRegularWindowSimulation(source, window, ranges, taxRates);
    if (simulation) simulations.push(simulation);
  }
  return simulations;
}

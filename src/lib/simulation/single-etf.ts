import type { EtfConfig, EtfResult } from "./types";
import { calcCagr, calcPathMetrics, EMPTY_PATH_METRICS } from "./metrics";
import {
  CONSTANT_INITIAL_INVESTMENT,
  getRiskOffSpread,
  getSymbolSpread,
  getTransitionSpreadCostForConfig,
} from "../constants";
import { DEFAULT_SMA_EXECUTION_MODE } from "../input-normalization";
import { getHistoricalPriceSymbol } from "./etf-config-expansion";
import { computeSimulatedRiskOnReturn } from "./swap-spread";
import { resolveSmaExecution, type SmaExecution, type SmaExecutionMode, type SmaSeed } from "./sma-execution";
import {
  markBasketAtClose,
  markBasketOnOpenEntryDay,
  openBasketAtClose,
  openBasketAtOpen,
  valueBasketAtOpen,
  type RiskOffBasket,
  type RiskOffPriceSeries,
} from "./single-etf-risk-off";

type RiskOffSeriesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

const PROGRESS_REPORT_INTERVAL_DAYS = 256;

export interface SimulateSingleEtfOptions extends SmaSeed {
  /** Skip metric calculations (drawdown, Sharpe, etc.) — use when only dailyValues/smaSignals are needed */
  skipMetrics?: boolean;
  /** Pre-computed leveraged risk-on daily returns (same leverage/ER/index across sweep configs) */
  precomputedRiskOnReturns?: number[];
}

/** Everything one day's step reads that does not change from day to day. */
interface DayStepContext {
  config: EtfConfig;
  dates: string[];
  indexValues: number[];
  indexReturns: number[];
  openPrices: number[];
  closePrices: number[];
  borrowRates: number[];
  riskOffPrices: RiskOffPriceSeries;
  /** Real ETF closes/opens for a non-simulated config, aligned to `dates`. */
  actualCloses?: number[];
  actualOpens?: number[];
  precomputedRiskOnReturns?: number[];
  erDaily: number;
  execution: SmaExecution;
}

function isPositiveFinite(value: number | undefined): value is number {
  return Number.isFinite(value) && (value ?? 0) > 0;
}

/** Day i's risk-on return: the real ETF's when it traded both days, else the simulated LETF. */
function riskOnDailyReturn(ctx: DayStepContext, i: number): number {
  const prevActual = ctx.actualCloses?.[i - 1];
  const actual = ctx.actualCloses?.[i];
  if (isPositiveFinite(actual) && isPositiveFinite(prevActual)) {
    // Use actual ETF price returns (no leverage formula, no expense deduction)
    return (actual - prevActual) / prevActual;
  }
  if (ctx.precomputedRiskOnReturns) {
    // Fast path: sweep configs share identical leverage/ER/index — returns pre-computed once
    return ctx.precomputedRiskOnReturns[i];
  }
  return computeSimulatedRiskOnReturn(
    ctx.indexReturns[i],
    ctx.borrowRates[i],
    ctx.config.smaIndex,
    ctx.config.leverage,
    ctx.erDaily
  );
}

/**
 * Return over half a session (overnight, or open to close) on a day that
 * switches regime at the open: the real ETF's move when both prices exist,
 * else the simulated LETF on the index's move with half the carrying costs.
 */
function halfSessionRiskOnReturn(
  ctx: DayStepContext,
  i: number,
  actualFrom: number | undefined,
  actualTo: number | undefined,
  indexFrom: number,
  indexTo: number
): number {
  if (isPositiveFinite(actualFrom) && isPositiveFinite(actualTo)) {
    return (actualTo / actualFrom) - 1;
  }
  return computeSimulatedRiskOnReturn(
    indexTo / indexFrom - 1,
    ctx.borrowRates[i],
    ctx.config.smaIndex,
    ctx.config.leverage,
    ctx.erDaily,
    0.5
  );
}

function isRiskOffOn(execution: SmaExecution, i: number): boolean {
  return Boolean(execution.investedForReturn && !execution.investedForReturn[i]);
}

/**
 * Pre-spread close value of a day that switches regime at its open
 * (next-day-open execution). Returns the new basket (null once risk-on).
 */
function stepOpenTransition(
  ctx: DayStepContext,
  i: number,
  previousValue: number,
  basket: RiskOffBasket | null
): { value: number; basket: RiskOffBasket | null } {
  const previousClose = ctx.indexValues[i - 1];
  const currentOpen = ctx.openPrices[i] ?? ctx.closePrices[i];
  const currentClose = ctx.indexValues[i];
  if (!isPositiveFinite(previousClose) || !isPositiveFinite(currentOpen) || !isPositiveFinite(currentClose)) {
    throw new Error(`Missing valid open/close prices for ${ctx.config.smaIndex} on ${ctx.dates[i]}`);
  }

  const previousInRiskOff = isRiskOffOn(ctx.execution, i - 1);
  const inRiskOff = isRiskOffOn(ctx.execution, i);

  if (!previousInRiskOff && inRiskOff) {
    const overnight = halfSessionRiskOnReturn(
      ctx, i, ctx.actualCloses?.[i - 1], ctx.actualOpens?.[i], previousClose, currentOpen
    );
    const entered = openBasketAtOpen(ctx.config.riskOffAsset, previousValue * (1 + overnight), ctx.riskOffPrices, i);
    return { value: markBasketOnOpenEntryDay(entered, ctx.riskOffPrices, i, ctx.borrowRates[i]), basket: entered };
  }

  if (previousInRiskOff && !inRiskOff) {
    const intraday = halfSessionRiskOnReturn(
      ctx, i, ctx.actualOpens?.[i], ctx.actualCloses?.[i], currentOpen, currentClose
    );
    const openValue = basket && basket.tickers.length > 0
      ? valueBasketAtOpen(basket, ctx.riskOffPrices, i)
      : previousValue;
    return { value: openValue * (1 + intraday), basket: null };
  }

  return { value: previousValue * (1 + riskOnDailyReturn(ctx, i)), basket };
}

/**
 * Pre-spread close value of day i, and the basket held after it. A held
 * basket is re-bought on a close-executed switch into risk-off.
 */
function stepDay(
  ctx: DayStepContext,
  executionMode: SmaExecutionMode,
  i: number,
  previousValue: number,
  basket: RiskOffBasket | null
): { value: number; basket: RiskOffBasket | null } {
  const hasTransition = Boolean(ctx.execution.transitionOnDay?.[i]);
  if (executionMode === "next-day-open" && hasTransition) {
    return stepOpenTransition(ctx, i, previousValue, basket);
  }
  if (isRiskOffOn(ctx.execution, i)) {
    const held = basket === null || hasTransition
      ? openBasketAtClose(ctx.config.riskOffAsset, previousValue, ctx.riskOffPrices, i - 1)
      : basket;
    return { value: markBasketAtClose(held, ctx.riskOffPrices, i, ctx.borrowRates[i]), basket: held };
  }
  return { value: previousValue * (1 + riskOnDailyReturn(ctx, i)), basket: null };
}

/**
 * Entry/exit spreads for the whole run, from the regime held on its first and
 * last day. Both use regular-hours spreads: the backtest's setup and final
 * liquidation are never after-hours trades.
 *
 * trigger-day-close executes signals same-day, so a final-day signal transitions
 * at the exit close and the raw signal state is the position being liquidated;
 * the next-day modes already reflect their last executed transition in
 * investedForReturn[last].
 */
function runEdgeSpreads(
  config: EtfConfig,
  execution: SmaExecution,
  executionMode: SmaExecutionMode,
  dayCount: number
): { entrySpread: number; exitSpread: number } {
  const { investedForReturn } = execution;
  const startInRiskOff = config.smaEnabled && investedForReturn && investedForReturn[1] === false;
  const endInRiskOff = config.smaEnabled && (
    executionMode === "trigger-day-close"
      ? execution.smaEndInvested === false
      : Boolean(investedForReturn) && investedForReturn![dayCount - 1] === false
  );
  const riskOffSpread = getRiskOffSpread(config.riskOffAsset, false);
  const riskOnSpread = getSymbolSpread(config.name, false);
  return {
    entrySpread: startInRiskOff ? riskOffSpread : riskOnSpread,
    exitSpread: endInRiskOff ? riskOffSpread : riskOnSpread,
  };
}

/**
 * Simulate one LETF config over the full price range.
 *
 * Daily formula:
 *   R_LETF(t) = L * R_index(t) - ER_daily - (|L| - 1) * (R_borrow(t) + swapSpread_daily)
 *
 * NAV(t) = NAV(t-1) * (1 + R_LETF(t)), floored at 0, minus the transition
 * spread on switch days. The entry spread is baked into day 0; the exit spread
 * comes off the reported final value only (see window-calculations.ts).
 */
export function simulateSingleEtf(
  config: EtfConfig,
  dates: string[],
  indexValues: number[],
  indexReturns: number[],  // Pre-computed daily index returns
  openPrices: number[],
  closePrices: number[],
  dailyBorrowingRates: number[],  // Pre-computed daily borrowing rates (O(1) lookup)
  riskOffValuesByAsset?: RiskOffSeriesByAsset,
  riskOffOpenValuesByAsset?: RiskOffSeriesByAsset,
  etfPricesByName?: Record<string, number[]>,
  etfOpenPricesByName?: Record<string, number[]>,
  onProgress?: (completedSteps: number, totalSteps: number) => void,
  options?: SimulateSingleEtfOptions
): EtfResult {
  const executionMode = config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE;
  const execution = resolveSmaExecution(config, dates, closePrices, executionMode, options);

  // Use actual ETF returns when aligned prices exist. Simulated presets can
  // still use this for post-launch history while falling back to synthetic
  // LETF math before launch.
  const historicalPriceSymbol = getHistoricalPriceSymbol(config.name);
  const ctx: DayStepContext = {
    config,
    dates,
    indexValues,
    indexReturns,
    openPrices,
    closePrices,
    borrowRates: dailyBorrowingRates,
    riskOffPrices: { close: riskOffValuesByAsset, open: riskOffOpenValuesByAsset },
    actualCloses: config.simulated ? undefined : etfPricesByName?.[historicalPriceSymbol],
    actualOpens: config.simulated ? undefined : etfOpenPricesByName?.[historicalPriceSymbol],
    precomputedRiskOnReturns: options?.precomputedRiskOnReturns,
    erDaily: config.expenseRatio / 100 / 252,
    execution,
  };

  // Per-symbol spread cost: trigger-day-close = after hours, everything else (including buy-and-hold) = regular hours
  const perTransitionSpread = config.smaEnabled
    ? getTransitionSpreadCostForConfig(config, executionMode === "trigger-day-close")
    : 0;
  const { entrySpread, exitSpread } = runEdgeSpreads(config, execution, executionMode, dates.length);

  // Initial investment reflects entry spread cost (e.g. $9,999 instead of $10,000)
  const dailyValues = new Array<number>(dates.length);
  dailyValues[0] = CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread);
  let totalSpreadDollarCost = CONSTANT_INITIAL_INVESTMENT * entrySpread;
  let basket: RiskOffBasket | null = null;

  for (let i = 1; i < dates.length; i++) {
    const step = stepDay(ctx, executionMode, i, dailyValues[i - 1], basket);
    basket = step.basket;

    if (execution.transitionOnDay?.[i]) {
      totalSpreadDollarCost += step.value * perTransitionSpread;
      dailyValues[i] = Math.max(step.value * (1 - perTransitionSpread), 0);
    } else {
      // Floor at 0: a leveraged ETF can't go below zero (you can't lose
      // more than your investment). Without this, a 3x ETF on a -34% day
      // would produce a negative portfolio value and >100% drawdowns.
      dailyValues[i] = Math.max(step.value, 0);
    }

    if (onProgress && (i === dates.length - 1 || i % PROGRESS_REPORT_INTERVAL_DAYS === 0)) {
      onProgress(i, dates.length - 1);
    }
  }

  // Check for NaN propagation in the final value (indicates corrupted input data)
  const lastValue = dailyValues[dailyValues.length - 1];
  if (!isFinite(lastValue)) {
    console.warn(`[engine] NaN/Infinity detected in final value for ${config.id}. First NaN at index:`,
      dailyValues.findIndex((v) => !isFinite(v)));
  }

  const identity = {
    id: config.id,
    name: config.name,
    sourceIndex: config.smaIndex,
    ...(config.smaEnabled && config.signalRule ? { signalRule: config.signalRule } : {}),
    dates,
    dailyValues,
  };
  const smaFields = {
    smaSignals: execution.smaSignals,
    smaPrices: execution.smaPrices,
    smaStartInvested: execution.smaStartInvested,
  };

  // When skipMetrics is set, skip expensive O(n) metric computations.
  // The precompute step only needs dailyValues/smaSignals/smaPrices — metrics are
  // recomputed per-window in buildSimulationBuckets anyway.
  if (options?.skipMetrics) {
    return {
      ...identity,
      finalValue: lastValue,
      cagr: 0,
      ...EMPTY_PATH_METRICS,
      ...smaFields,
      totalTradingCostPct: 0,
    };
  }

  const exitDollarCost = lastValue * exitSpread;
  totalSpreadDollarCost += exitDollarCost;
  const finalValue = Math.max(0, lastValue - exitDollarCost);

  return {
    ...identity,
    finalValue,
    cagr: calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]),
    ...calcPathMetrics(dailyValues, dates),
    ...smaFields,
    totalTradingCostPct: finalValue > 0 ? (totalSpreadDollarCost / finalValue) * 100 : 0,
  };
}

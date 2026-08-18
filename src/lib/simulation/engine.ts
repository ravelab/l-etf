import type {
  PricePoint,
  RatePoint,
  EtfConfig,
  BacktestResult,
  EtfResult,
} from "./types";
import { buildRateLookup } from "./borrowing-rate";
import { riskOffCloseMarkPrice, riskOffOpenTradePrice } from "./risk-off";
import { generateSmaSignals } from "./sma";
import {
  calcCagr,
  calcMaxDrawdown,
  calcMaxDrawdownInRange,
  calcMonthlyExtremes,
  calcSharpeRatio,
} from "./metrics";
import {
  CONSTANT_INITIAL_INVESTMENT,
  getTransitionSpreadCostForConfig,
  getRiskOffFetchTickers,
  getSymbolSpread,
  getRiskOffSpread,
} from "../constants";
import { DEFAULT_SMA_EXECUTION_MODE } from "../input-normalization";
import { adjustedOpenFromPricePoint } from "../utils";
import { renormalizeSeriesFromIndex, resolveEdgeRiskOffStates, selectEdgeSpreads } from "./window-calculations";

/**
 * Pre-computed derived arrays from PricePoint[].
 * These are computed ONCE per unique price array and reused across all simulations.
 */
interface DerivedArrays {
  dates: string[];
  indexValues: number[];
  openPrices: number[];
  closePrices: number[];
  indexReturns: number[];  // Pre-computed daily returns: (index[i] - index[i-1]) / index[i-1]
}

/**
 * Global cache for derived arrays.
 * Uses content-hash based caching to hit even when array references differ
 * (e.g., sliced windows from the same underlying data).
 */
const derivedArraysCache = new Map<string, DerivedArrays>();
const derivedArraysWeakCache = new WeakMap<PricePoint[], DerivedArrays>();

/**
 * Compute a hash key for a PricePoint[] array for caching purposes.
 * Samples the array to avoid O(n) hash computation for large arrays.
 */
function hashPricePoints(prices: PricePoint[]): string {
  const len = prices.length;
  let hash = 2166136261;
  
  // Sample up to 500 points for hashing
  const step = Math.max(1, Math.floor(len / 500));
  for (let i = 0; i < len; i += step) {
    const p = prices[i];
    // Hash the date string
    for (let j = 0; j < p.date.length; j++) {
      hash ^= p.date.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
    // Hash both return-series close and SMA close so cache invalidates when either changes
    const adjustedBits = new Float64Array([p.adj_close]);
    const adjustedBytes = new Uint8Array(adjustedBits.buffer);
    for (let j = 0; j < adjustedBytes.length; j++) {
      hash ^= adjustedBytes[j];
      hash = Math.imul(hash, 16777619);
    }
    const smaCloseBits = new Float64Array([p.close]);
    const smaCloseBytes = new Uint8Array(smaCloseBits.buffer);
    for (let j = 0; j < smaCloseBytes.length; j++) {
      hash ^= smaCloseBytes[j];
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${len}:${hash >>> 0}`;
}

/**
 * Extract and pre-compute all derived arrays from PricePoint[].
 * Results are cached globally to avoid redundant computation across
 * rolling windows and multiple simulations.
 */
function extractDerivedArrays(prices: PricePoint[]): DerivedArrays {
  // Try WeakMap first (fastest, identity-based)
  const weakCached = derivedArraysWeakCache.get(prices);
  if (weakCached) return weakCached;

  // Try content-based cache
  const hashKey = hashPricePoints(prices);
  const cached = derivedArraysCache.get(hashKey);
  if (cached) {
    derivedArraysWeakCache.set(prices, cached);
    return cached;
  }

  // Compute fresh
  const dates = prices.map((p) => p.date);
  const indexValues = prices.map((p) => p.adj_close);

  // Pre-compute index returns ONCE
  const indexReturns = new Array<number>(prices.length);
  indexReturns[0] = 0;
  for (let i = 1; i < prices.length; i++) {
    const prev = indexValues[i - 1];
    const curr = indexValues[i];
    indexReturns[i] = prev !== 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
  }

  const result: DerivedArrays = {
    dates,
    indexValues,
    openPrices: prices.map(adjustedOpenFromPricePoint),
    closePrices: prices.map((p) => p.close),
    indexReturns,
  };

  // Cache the result
  derivedArraysCache.set(hashKey, result);
  derivedArraysWeakCache.set(prices, result);

  // Keep cache bounded
  if (derivedArraysCache.size > 500) {
    const entries = Array.from(derivedArraysCache.entries());
    derivedArraysCache.clear();
    for (let i = Math.max(0, entries.length - 250); i < entries.length; i++) {
      derivedArraysCache.set(entries[i][0], entries[i][1]);
    }
  }

  return result;
}

// Swap spread model: spread = rateSensitivity * borrowRate + baseSpread
// Calibrated via binary search against actual ETF cumulative returns:
//   2x: SSO (2006–2026) and QLD (2006–2026)
//   3x: UPRO (2009–2026) and TQQQ (2010–2026)
// The spread represents the total additional cost above the benchmark borrowing rate
// that real leveraged ETFs pay for swap/futures financing. It scales with rates because
// banks charge a proportional premium on leveraged exposure.
//
// At the daily level: swapSpreadDaily = (rateSensitivity * annualBorrowRate + baseSpread) / 360
// where annualBorrowRate = borrowRateDaily * 360.
//
// Note: baseSpread includes empirically-calibrated conservative adjustment
// to ensure simulations match real ETFs within <0.005% final return difference,
// accounting for tracking error and trading frictions not captured in the model.
export type SwapSpreadModel = { rateSensitivity: number; baseSpread: number };
let SWAP_SPREAD_MODEL: Record<string, Record<number, SwapSpreadModel>> = {
  // S&P 500 - calibrated 2026-08-03
  sp500: {
    // SSO (2x)
    2: { rateSensitivity: 0.718186, baseSpread: 0.004127 },
    // UPRO (3x)
    3: { rateSensitivity: 0.899306, baseSpread: 0.002997 },
  },
  // Nasdaq 100 - calibrated 2026-08-03
  nasdaq100: {
    // QLD (2x)
    2: { rateSensitivity: 0.899135, baseSpread: -0.000226 },
    // TQQQ (3x)
    3: { rateSensitivity: 1.078049, baseSpread: -0.001198 },
  },
};


const DEFAULT_SWAP_MODEL: SwapSpreadModel = { rateSensitivity: 0.7, baseSpread: 0.001 };

/**
 * Highest borrow rate the swap-spread model is actually fitted on.
 * `calibrate-etfs.ts` can only see the window where the real ETFs exist —
 * 2006-06-21 on for SSO/QLD, 2009/2010 on for UPRO/TQQQ — and the benchmark
 * tops out at 5.82% across it. The slope is well identified inside that range
 * (pinning it to zero blows UPRO's final tracking error out to 6%), but above
 * it there is no evidence at all, and a straight line compounds fast: at the
 * ~15% rates of 1981 it implies a 5–7%/yr credit spread over the risk-free
 * rate, several times anything a funding market has charged.
 */
const SWAP_SPREAD_CALIBRATED_RATE_MAX = 0.06;

/**
 * Slope the spread keeps above {@link SWAP_SPREAD_CALIBRATED_RATE_MAX}, where the
 * fitted credit spread holds flat but the risk-free rate must still pass through
 * in full. The engine charges `annualRate / 360` on ~252 trading days a year, so
 * the borrow term alone only delivers 252/360 of the rate; this covers the rest.
 * Without it, capping would make leveraged financing *cheaper* than risk-free.
 */
const SWAP_SPREAD_RATE_PASSTHROUGH_SLOPE = 360 / 252 - 1;

/**
 * Override the swap spread model (used by calibration script).
 * Returns the previous model so it can be restored.
 */
export function setSwapSpreadModel(
  model: Record<string, Record<number, SwapSpreadModel>>
): Record<string, Record<number, SwapSpreadModel>> {
  const prev = SWAP_SPREAD_MODEL;
  SWAP_SPREAD_MODEL = model;
  return prev;
}

/** Get a deep copy of the current swap spread model. */
export function getSwapSpreadModel(): Record<string, Record<number, SwapSpreadModel>> {
  return JSON.parse(JSON.stringify(SWAP_SPREAD_MODEL));
}

/**
 * Compute the daily swap spread for a given index, leverage, and borrowing rate.
 * borrowRateDaily is already in daily units (annualRate / 100 / 360).
 *
 * Inside the fitted rate range this is the calibrated line, unchanged. Above
 * {@link SWAP_SPREAD_CALIBRATED_RATE_MAX} the credit spread holds at its
 * end-of-range value while the rate itself still passes through in full, so a
 * 1970s–80s backtest pays a plausible premium over a high risk-free rate
 * instead of a fitted line extrapolated three times past its evidence.
 */
export function getSwapSpreadDaily(smaIndex: string, borrowRateDaily: number, leverage: number = 3): number {
  const indexModels = SWAP_SPREAD_MODEL[smaIndex];
  const model = indexModels?.[Math.abs(leverage)] ?? indexModels?.[3] ?? DEFAULT_SWAP_MODEL;
  const annualBorrowRate = borrowRateDaily * 360; // back to decimal (e.g. 0.05 for 5%)
  const fittedRate = Math.min(annualBorrowRate, SWAP_SPREAD_CALIBRATED_RATE_MAX);
  const extrapolatedRate = Math.max(0, annualBorrowRate - SWAP_SPREAD_CALIBRATED_RATE_MAX);
  const annualSpread =
    model.rateSensitivity * fittedRate +
    model.baseSpread +
    SWAP_SPREAD_RATE_PASSTHROUGH_SLOPE * extrapolatedRate;
  // Floor at 0: in extremely low/negative rate environments, spread shouldn't go deeply negative
  return Math.max(annualSpread, 0) / 360;
}

/**
 * If SMA is enabled, expand each config into its baseline (no SMA) and SMA variants
 * for side-by-side comparison in charts and tables.
 */
function expandEtfConfigs(etfConfigs: EtfConfig[]): EtfConfig[] {
  return etfConfigs.flatMap((config) => {
    if (!config.smaEnabled) return [config];
    const baselineConfig: EtfConfig = {
      ...config,
      id: `${config.id}-base`,
      name: `${config.name} (No SMA)`,
      smaEnabled: false,
    };
    const smaConfig: EtfConfig = {
      ...config,
      id: `${config.id}-sma`,
      name: `${config.name} (SMA, ${formatRiskOffAsset(config.riskOffAsset)})`,
    };
    return [baselineConfig, smaConfig];
  });
}

/**
 * Run a full backtest simulation.
 *
 * Daily formula:
 *   R_LETF(t) = L * R_index(t) - ER_daily - (|L| - 1) * (R_borrow(t) + swapSpread_daily)
 *
 * NAV(t) = NAV(t-1) * (1 + R_LETF(t))
 */
export function simulateBacktest(
  prices: PricePoint[],
  rates: RatePoint[],
  etfConfigs: EtfConfig[],
  options?: {
    riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    etfPricesByName?: Record<string, number[]>;
    etfOpenPricesByName?: Record<string, number[]>;
    onProgress?: (completedUnits: number, totalUnits: number) => void;
  }
): BacktestResult {
  if (prices.length < 2) {
    return {
      dates: [],
      nonLeveragedValues: [],
      investedValues: [],
      etfResults: [],
    };
  }

  const rateLookup = buildRateLookup(rates);
  const { dates, indexValues, openPrices, closePrices, indexReturns } = extractDerivedArrays(prices);

  // Pre-compute daily borrowing rates for O(1) lookup during simulation
  const dailyBorrowingRates = new Array<number>(prices.length);
  for (let i = 0; i < prices.length; i++) {
    dailyBorrowingRates[i] = rateLookup.getRate(prices[i].date);
  }

  // Non-leveraged (1x, no fees) baseline
  const nonLeveragedValues = computeNonLeveraged(indexValues);

  // Invested values (flat line)
  const investedValues = new Array(dates.length).fill(CONSTANT_INITIAL_INVESTMENT);

  const expandedConfigs = expandEtfConfigs(etfConfigs);

  const uniqueExpandedConfigs = dedupeExpandedConfigs(expandedConfigs);
  const stepsPerConfig = Math.max(1, dates.length - 1);
  const totalUnits = uniqueExpandedConfigs.length * stepsPerConfig;
  let completedUnits = 0;

  const etfResults = uniqueExpandedConfigs
    .map((config) =>
      simulateSingleEtf(
        config,
        dates,
        indexValues,
        indexReturns,
        openPrices,
        closePrices,
        dailyBorrowingRates,
        options?.riskOffValuesByAsset,
        options?.riskOffOpenValuesByAsset,
        options?.etfPricesByName,
        options?.etfOpenPricesByName,
        (completedSteps, totalSteps) => {
          if (!options?.onProgress) return;
          options.onProgress(
            completedUnits + Math.min(completedSteps, totalSteps),
            totalUnits
          );
        }
      )
    )
    .map((result) => {
      completedUnits += stepsPerConfig;
      options?.onProgress?.(completedUnits, totalUnits);
      return result;
    })
    .sort(compareEtfResultOrder);

  return {
    dates,
    nonLeveragedValues,
    investedValues,
    etfResults,
  };
}

function compareEtfResultOrder(a: EtfResult, b: EtfResult): number {
  const aInfo = parseVariant(a.id);
  const bInfo = parseVariant(b.id);
  if (aInfo.baseId !== bInfo.baseId) return aInfo.baseId.localeCompare(bInfo.baseId);
  return aInfo.rank - bInfo.rank;
}

function parseVariant(id: string): { baseId: string; rank: number } {
  if (id.endsWith("-base")) return { baseId: id.slice(0, -5), rank: 0 };
  if (id.endsWith("-sma")) return { baseId: id.slice(0, -4), rank: 1 };
  if (id.endsWith("-smaOpen")) return { baseId: id.slice(0, -8), rank: 2 };
  if (id.endsWith("-smaClose")) return { baseId: id.slice(0, -9), rank: 3 };
  return { baseId: id, rank: 0 };
}

function formatRiskOffAsset(asset: EtfConfig["riskOffAsset"]): string {
  return asset.replace(/BRK\.A/g, "BRK.B").replace(/\+/g, " + ");
}

function dedupeExpandedConfigs(configs: EtfConfig[]): EtfConfig[] {
  const seen = new Set<string>();
  const unique: EtfConfig[] = [];
  for (const config of configs) {
    const key = buildDedupeKey(config);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(config);
  }
  return unique;
}

function buildDedupeKey(config: EtfConfig): string {
  const base = {
    symbol: getHistoricalPriceSymbol(config.name),
    leverage: config.leverage,
    expenseRatio: config.expenseRatio,
    simulated: config.simulated,
    smaIndex: config.smaIndex,
    smaEnabled: config.smaEnabled,
  };

  if (!config.smaEnabled) {
    return JSON.stringify(base);
  }

  return JSON.stringify({
    ...base,
    smaPeriod: config.smaPeriod,
    smaUpperBuffer: config.smaUpperBuffer,
    smaLowerBuffer: config.smaLowerBuffer,
    riskOffAsset: config.riskOffAsset,
    smaExecutionMode: config.smaExecutionMode,
  });
}

const nonLeveragedCache = new WeakMap<number[], number[]>();

function computeNonLeveraged(indexValues: number[]): number[] {
  const cached = nonLeveragedCache.get(indexValues);
  if (cached) return cached;

  const values = new Array(indexValues.length);
  values[0] = CONSTANT_INITIAL_INVESTMENT;
  for (let i = 1; i < indexValues.length; i++) {
    const dailyReturn = (indexValues[i] - indexValues[i - 1]) / indexValues[i - 1];
    values[i] = values[i - 1] * (1 + dailyReturn);
  }

  nonLeveragedCache.set(indexValues, values);
  return values;
}

export function simulateSingleEtf(
  config: EtfConfig,
  dates: string[],
  indexValues: number[],
  indexReturns: number[],  // Pre-computed daily index returns
  openPrices: number[],
  closePrices: number[],
  dailyBorrowingRates: number[],  // Pre-computed daily borrowing rates (O(1) lookup)
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  etfPricesByName?: Record<string, number[]>,
  etfOpenPricesByName?: Record<string, number[]>,
  onProgress?: (completedSteps: number, totalSteps: number) => void,
  options?: {
    /** Skip metric calculations (drawdown, Sharpe, etc.) — use when only dailyValues/smaSignals are needed */
    skipMetrics?: boolean;
    /** Pre-computed leveraged risk-on daily returns (same leverage/ER/index across sweep configs) */
    precomputedRiskOnReturns?: number[];
    /** Seed for the SMA invested state at index 0 (defaults to true). Used by the
     *  History Wrap tail simulation to start in the real simulation's regime at
     *  the join instead of always starting risk-on. */
    smaInitialInvested?: boolean;
    /** Index at which `smaInitialInvested` becomes authoritative (defaults to 0). Lets
     *  the History Wrap tail simulation hold its seed through the SMA warm-up bootstrap
     *  until the join date, rather than at series start. */
    smaSeedAtIndex?: number;
  }
): EtfResult {
  // Use actual ETF returns when aligned prices exist. Simulated presets can
  // still use this for post-launch history while falling back to synthetic
  // LETF math before launch.
  const historicalPriceSymbol = getHistoricalPriceSymbol(config.name);
  const historicalPrices = etfPricesByName?.[historicalPriceSymbol];
  const historicalOpenPrices = etfOpenPricesByName?.[historicalPriceSymbol];

  const L = config.leverage;
  const erDaily = config.expenseRatio / 100 / 252;
  const executionMode = config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE;

  // Compute SMA signals if enabled
  let investedForReturn: boolean[] | null = null;
  let transitionOnDay: boolean[] | null = null;
  let smaSignals: EtfResult["smaSignals"] = [];
  let smaPrices: number[] = [];
  let smaStartInvested: boolean | undefined;
  let smaEndInvested: boolean | undefined;

  if (config.smaEnabled) {
    const missingCloseIdx = closePrices.findIndex((price) => !isFinite(price));
    if (missingCloseIdx !== -1) {
      throw new Error(`Missing close price for ${config.smaIndex} on ${dates[missingCloseIdx]}`);
    }
    const smaResult = generateSmaSignals(
      dates,
      closePrices,
      config.smaPeriod,
      { upper: config.smaUpperBuffer, lower: config.smaLowerBuffer },
      options?.smaInitialInvested !== undefined
        ? { initialInvested: options.smaInitialInvested, seedAtIndex: options?.smaSeedAtIndex }
        : undefined
    );
    const signalInvested = smaResult.invested;
    smaSignals = smaResult.signals;
    smaPrices = smaResult.smaValues;
    smaStartInvested = signalInvested[0] ?? true;
    smaEndInvested = signalInvested[signalInvested.length - 1] ?? true;
    
    // Choose execution mode: next-day open (default), next-day close, or trigger-day close.
    if (executionMode === "next-day-close") {
      // Signals generated from close → execute at next day's close.
      // Signal on day 10 → exit at day 11 close (get both day 10 and 11 returns).
      // Shift by 2 days: investedForReturn[i] = smaResult.invested[i-2]
      investedForReturn = buildInvestedForNextDayCloseExecution(signalInvested);
      // Transition happens 2 days after the signal
      transitionOnDay = buildTransitionFlagsDelayed(signalInvested, 2);
    } else if (executionMode === "next-day-open") {
      // Signals generated from close → execute at next day's open.
      // Signal on day 10 → transition at day 11 open → day 11 close reflects new regime.
      investedForReturn = buildInvestedForNextDayOpenExecution(signalInvested);
      transitionOnDay = buildTransitionFlagsDelayed(signalInvested, 1);
    } else {
      // Signals are generated from close → execute at trigger-day close.
      // Signal on day 10 → exit at day 10 close (get day 10 return).
      // Shift by 1 day: investedForReturn[i] = smaResult.invested[i-1]
      investedForReturn = buildInvestedForCloseExecution(signalInvested);
      transitionOnDay = buildTransitionFlags(signalInvested);
    }
  }

  const dailyValues = new Array(dates.length);
  const transitionDates: string[] = [];
  
  // Per-symbol spread cost: trigger-day-close = after hours, everything else (including buy-and-hold) = regular hours
  const afterHours = executionMode === "trigger-day-close";
  const perTransitionSpread = config.smaEnabled
    ? getTransitionSpreadCostForConfig(config, afterHours)
    : 0;

  // Signal state at the start/end of the window determines which spread to use for entry/exit.
  // trigger-day-close executes signals same-day, so a final-day signal transitions at the exit
  // close and the raw signal state is the position being liquidated; the next-day modes already
  // reflect their last executed transition in investedForReturn[last].
  const startInRiskOff = config.smaEnabled && investedForReturn && investedForReturn[1] === false;
  const endInRiskOff = config.smaEnabled && (
    executionMode === "trigger-day-close"
      ? smaEndInvested === false
      : Boolean(investedForReturn) && investedForReturn![dates.length - 1] === false
  );

  // Initial entry spread: always use regular hours for backtest setup
  const entrySpread = startInRiskOff
    ? getRiskOffSpread(config.riskOffAsset, false)
    : getSymbolSpread(config.name, false);

  // Final exit spread: always use regular hours spread for the final liquidation
  const exitSpread = endInRiskOff
    ? getRiskOffSpread(config.riskOffAsset, false)
    : getSymbolSpread(config.name, false);

  // Initial investment reflects entry spread cost (e.g. $9,999 instead of $10,000)
  const initialAfterSpread = CONSTANT_INITIAL_INVESTMENT * (1 - entrySpread);
  dailyValues[0] = initialAfterSpread;
  let totalSpreadDollarCost = CONSTANT_INITIAL_INVESTMENT * entrySpread;

  // Track risk-off mixture state. Rebalances to equal weights ONLY on entry to risk-off.
  // This ensures that even if a simulation starts in 1885, a risk-off entry in 1972
  // starts with the specified proportions.
  // Track risk-off positions as actual units/shares to compute value directly from prices.
  // This completely eliminates floating point compounding errors and compares buy vs sell prices directly.
  let riskOffShares: number[] | null = null;
  let riskOffCash: number[] | null = null;
  let riskOffTickers: string[] = [];

  for (let i = 1; i < dates.length; i++) {
    const borrowRate = dailyBorrowingRates[i];  // O(1) array access instead of binary search!
    const transitionAtOpen = executionMode === "next-day-open" && Boolean(transitionOnDay?.[i]);

    let riskOnDailyReturn = 0;

    const hasActualEtfReturn =
      !config.simulated &&
      historicalPrices &&
      Number.isFinite(historicalPrices[i]) &&
      Number.isFinite(historicalPrices[i - 1]) &&
      historicalPrices[i] > 0 &&
      historicalPrices[i - 1] > 0;
    if (hasActualEtfReturn) {
      // Use actual ETF price returns (no leverage formula, no expense deduction)
      riskOnDailyReturn =
        (historicalPrices![i] - historicalPrices![i - 1]) / historicalPrices![i - 1];
    } else if (options?.precomputedRiskOnReturns) {
      // Fast path: sweep configs share identical leverage/ER/index — returns pre-computed once
      riskOnDailyReturn = options.precomputedRiskOnReturns[i];
    } else {
      // Simulated: use pre-computed index return (no division needed!)
      riskOnDailyReturn = computeSimulatedRiskOnReturn(
        indexReturns[i],
        borrowRate,
        config.smaIndex,
        L,
        erDaily
      );
    }

    const hasTransition = Boolean(transitionOnDay?.[i]);
    const inRiskOff = Boolean(investedForReturn && !investedForReturn[i]);

    let baseValue = 0;

    if (transitionAtOpen) {
      const previousInRiskOff = Boolean(investedForReturn && !investedForReturn[i - 1]);
      const previousClose = indexValues[i - 1];
      const currentOpen = openPrices[i] ?? closePrices[i];
      const currentClose = indexValues[i];

      if (
        !isFinite(previousClose) || previousClose <= 0 ||
        !isFinite(currentOpen) || currentOpen <= 0 ||
        !isFinite(currentClose) || currentClose <= 0
      ) {
        throw new Error(`Missing valid open/close prices for ${config.smaIndex} on ${dates[i]}`);
      }

      if (!previousInRiskOff && inRiskOff) {
        const actualPrevClose = !config.simulated ? historicalPrices?.[i - 1] : undefined;
        const actualOpen = !config.simulated ? historicalOpenPrices?.[i] : undefined;
        const hasActualOvernight =
          Number.isFinite(actualPrevClose) &&
          Number.isFinite(actualOpen) &&
          (actualPrevClose ?? 0) > 0 &&
          (actualOpen ?? 0) > 0;
        const overnightRiskOnReturn = hasActualOvernight
          ? ((actualOpen as number) / (actualPrevClose as number)) - 1
          : computeSimulatedRiskOnReturn(
              currentOpen / previousClose - 1,
              borrowRate,
              config.smaIndex,
              L,
              erDaily,
              0.5
            );
        const investableValue = dailyValues[i - 1] * (1 + overnightRiskOnReturn);
        riskOffTickers = getRiskOffFetchTickers(config.riskOffAsset);
        riskOffShares = new Array(riskOffTickers.length).fill(0);
        riskOffCash = new Array(riskOffTickers.length).fill(0);
        const valuePerComponent = investableValue / riskOffTickers.length;
        for (let j = 0; j < riskOffTickers.length; j++) {
          const ticker = riskOffTickers[j];
          const closeValues = riskOffValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
          const openValues = riskOffOpenValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
          const tradePrice = riskOffOpenTradePrice({
            openValues,
            closeValues,
            index: i,
          });
          if (isFinite(tradePrice ?? NaN) && (tradePrice ?? 0) > 0) {
            riskOffShares[j] = valuePerComponent / (tradePrice as number);
          } else {
            riskOffCash[j] = valuePerComponent;
          }
        }

        for (let j = 0; j < riskOffTickers.length; j++) {
          const ticker = riskOffTickers[j];
          const closeValues = riskOffValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
          if (riskOffShares[j] > 0) {
            const markPrice = riskOffCloseMarkPrice({ closeValues, index: i });
            if (Number.isFinite(markPrice)) {
              baseValue += riskOffShares[j] * markPrice;
            } else {
              const openValues = riskOffOpenValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
              const lastPrice = riskOffOpenTradePrice({ openValues, closeValues, index: i });
              if (riskOffCash) {
                riskOffCash[j] = riskOffShares[j] * (Number.isFinite(lastPrice) ? lastPrice : 1);
                riskOffShares[j] = 0;
                const fallbackReturn = borrowRate > 0 ? borrowRate : 0;
                riskOffCash[j] *= (1 + fallbackReturn);
                baseValue += riskOffCash[j];
              }
            }
          } else if (riskOffCash) {
            baseValue += riskOffCash[j];
          }
        }
      } else if (previousInRiskOff && !inRiskOff) {
        const actualOpen = !config.simulated ? historicalOpenPrices?.[i] : undefined;
        const actualClose = !config.simulated ? historicalPrices?.[i] : undefined;
        const hasActualIntraday =
          Number.isFinite(actualOpen) &&
          Number.isFinite(actualClose) &&
          (actualOpen ?? 0) > 0 &&
          (actualClose ?? 0) > 0;
        const intradayRiskOnReturn = hasActualIntraday
          ? ((actualClose as number) / (actualOpen as number)) - 1
          : computeSimulatedRiskOnReturn(
              currentClose / currentOpen - 1,
              borrowRate,
              config.smaIndex,
              L,
              erDaily,
              0.5
            );
        const openPortfolioValue = riskOffShares && riskOffTickers.length > 0
          ? riskOffTickers.reduce((sum, ticker, j) => {
              const closeValues = riskOffValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
              const openValues = riskOffOpenValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
              const openPrice = riskOffOpenTradePrice({
                openValues,
                closeValues,
                index: i,
              });
              if (riskOffShares![j] > 0) {
                if (Number.isFinite(openPrice)) return sum + riskOffShares![j] * openPrice;
                return sum + riskOffShares![j];
              }
              return sum + (riskOffCash?.[j] ?? 0);
            }, 0)
          : dailyValues[i - 1];
        baseValue = openPortfolioValue * (1 + intradayRiskOnReturn);
        riskOffShares = null;
        riskOffCash = null;
      } else {
        baseValue = dailyValues[i - 1] * (1 + riskOnDailyReturn);
      }
    } else if (inRiskOff) {
      if (riskOffShares === null || hasTransition) {
        // Transition into risk-off: Allocate portfolio value equally among components
        riskOffTickers = getRiskOffFetchTickers(config.riskOffAsset);
        riskOffShares = new Array(riskOffTickers.length).fill(0);
        riskOffCash = new Array(riskOffTickers.length).fill(0);
        
        const investableValue = dailyValues[i - 1];
        const valuePerComponent = investableValue / riskOffTickers.length;

        for (let j = 0; j < riskOffTickers.length; j++) {
          const ticker = riskOffTickers[j];
          const values = riskOffValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
          
          const entryPrice = riskOffCloseMarkPrice({ closeValues: values, index: i - 1 });
          if (Number.isFinite(entryPrice)) {
            riskOffShares[j] = valuePerComponent / entryPrice;
          } else {
            // Fallback: If no price data, store the dollar value to be compounded
            riskOffCash[j] = valuePerComponent;
          }
        }
      }

      for (let j = 0; j < riskOffTickers.length; j++) {
        const ticker = riskOffTickers[j];
        const values = riskOffValuesByAsset?.[ticker as EtfConfig["riskOffAsset"]];
        
        if (riskOffShares[j] > 0) {
          const markPrice = riskOffCloseMarkPrice({ closeValues: values, index: i });
          if (Number.isFinite(markPrice)) {
            // Normal case: value is shares * current price
            baseValue += riskOffShares[j] * markPrice;
          } else {
            // Price is suddenly missing. Convert to cash and compound with borrow rate.
            // (No console warning: this runs inside the daily loop across every sweep
            // config and would flood the console; the fallback is the designed handling.)
            const lastPrice = riskOffCloseMarkPrice({ closeValues: values, index: i - 1 });
            if (riskOffCash) {
              riskOffCash[j] = riskOffShares[j] * (Number.isFinite(lastPrice) ? lastPrice : 1);
              riskOffShares[j] = 0;

              const fallbackReturn = borrowRate > 0 ? borrowRate : 0;
              riskOffCash[j] *= (1 + fallbackReturn);
              baseValue += riskOffCash[j];
            }
          }
        } else {
          // Compounding cash fallback
          const fallbackReturn = borrowRate > 0 ? borrowRate : 0;
          if (riskOffCash) {
            riskOffCash[j] *= (1 + fallbackReturn);
            baseValue += riskOffCash[j];
          }
        }
      }
    } else {
      // Risk-on day
      baseValue = dailyValues[i - 1] * (1 + riskOnDailyReturn);
      riskOffShares = null;
      riskOffCash = null;
    }

    if (hasTransition) {
      totalSpreadDollarCost += baseValue * perTransitionSpread;
      const spreadMultiplier = 1 - perTransitionSpread;
      dailyValues[i] = Math.max(baseValue * spreadMultiplier, 0);
      if (transitionDates.length < 20) transitionDates.push(dates[i]);
      continue;
    }

    // Floor at 0: a leveraged ETF can't go below zero (you can't lose
    // more than your investment). Without this, a 3x ETF on a -34% day
    // would produce a negative portfolio value and >100% drawdowns.
    dailyValues[i] = Math.max(baseValue, 0);

    if (onProgress && (i === dates.length - 1 || i % 256 === 0)) {
      onProgress(i, dates.length - 1);
    }
  }

  // Check for NaN propagation in the final value (indicates corrupted input data)
  const lastValue = dailyValues[dailyValues.length - 1];
  if (!isFinite(lastValue)) {
    console.warn(`[engine] NaN/Infinity detected in final value for ${config.id}. First NaN at index:`,
      dailyValues.findIndex((v) => !isFinite(v)));
  }

  // When skipMetrics is set, skip expensive O(n) metric computations.
  // The precompute step only needs dailyValues/smaSignals/smaPrices — metrics are
  // recomputed per-window in buildSimulationBuckets anyway.
  if (options?.skipMetrics) {
    return {
      id: config.id,
      name: config.name,
      sourceIndex: config.smaIndex,
      dates,
      dailyValues,
      finalValue: dailyValues[dailyValues.length - 1],
      cagr: 0,
      sharpeRatio: 0,
      maxDrawdownPct: 0,
      maxDrawdownDollar: 0,
      longestDrawdownDays: 0,
      bestMonth: 0,
      worstMonth: 0,
      smaSignals,
      smaPrices,
      smaStartInvested,
      totalTradingCostPct: 0,
    };
  }

  const drawdown = calcMaxDrawdown(dailyValues, dates);
  const monthlyExtremes = calcMonthlyExtremes(dailyValues, dates);
  const sharpeRatio = calcSharpeRatio(dailyValues);

  const rawFinalValue = dailyValues[dailyValues.length - 1];
  const exitDollarCost = rawFinalValue * exitSpread;
  totalSpreadDollarCost += exitDollarCost;
  const finalValue = Math.max(0, rawFinalValue - exitDollarCost);

  const cagr = calcCagr(
    CONSTANT_INITIAL_INVESTMENT,
    finalValue,
    dates[0],
    dates[dates.length - 1]
  );

  const totalTradingCostPct = finalValue > 0
    ? (totalSpreadDollarCost / finalValue) * 100
    : 0;

  return {
    id: config.id,
    name: config.name,
    sourceIndex: config.smaIndex,
    dates,
    dailyValues,
    finalValue,
    cagr,
    sharpeRatio,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
    smaSignals,
    smaPrices,
    smaStartInvested,
    totalTradingCostPct,
  };
}

function stripStrategySuffix(name: string): string {
  return name
    .replace(/ \(No SMA\)$/, "")
    .replace(/ \(SMA Trigger-Day Close[^)]*\)$/, "")
    .replace(/ \(SMA Next-Day Open[^)]*\)$/, "")
    .replace(/ \(SMA Next-Day Close[^)]*\)$/, "")
    .replace(/ \(SMA[^)]*\)$/, "");
}

function getHistoricalPriceSymbol(name: string): string {
  return stripStrategySuffix(name).replace(/-real$/, "");
}

function buildTransitionFlagsDelayed(invested: boolean[], delay: number): boolean[] {
  const flags = new Array<boolean>(invested.length).fill(false);
  for (let i = 1; i < invested.length; i++) {
    if (invested[i] !== invested[i - 1]) {
      // Mark transition 'delay' days after the signal
      const transitionDay = i + delay;
      if (transitionDay < invested.length) {
        flags[transitionDay] = true;
      }
    }
  }
  return flags;
}

function buildTransitionFlags(invested: boolean[]): boolean[] {
  const flags = new Array<boolean>(invested.length).fill(false);
  for (let i = 1; i < invested.length; i++) {
    flags[i] = invested[i] !== invested[i - 1];
  }
  return flags;
}

function buildInvestedForCloseExecution(invested: boolean[]): boolean[] {
  if (invested.length <= 1) return invested;
  const shifted = new Array<boolean>(invested.length);
  shifted[0] = invested[0];
  for (let i = 1; i < invested.length; i++) {
    shifted[i] = invested[i - 1];
  }
  return shifted;
}

function buildInvestedForNextDayCloseExecution(invested: boolean[]): boolean[] {
  if (invested.length <= 1) return invested;
  const shifted = new Array<boolean>(invested.length);
  shifted[0] = invested[0];
  shifted[1] = invested[0];
  for (let i = 2; i < invested.length; i++) {
    // Signal on day i-2 → exit at day i-1 close → out on day i
    shifted[i] = invested[i - 2];
  }
  return shifted;
}

/** Used by tooling/tests to mirror ETF SMA `next-day-open` execution vs raw `generateSmaSignals` flags. */
export function buildInvestedForNextDayOpenExecution(invested: boolean[]): boolean[] {
  return buildInvestedForCloseExecution(invested);
}

export function computeSimulatedRiskOnReturn(
  indexReturn: number,
  borrowRate: number,
  smaIndex: EtfConfig["smaIndex"],
  leverage: number,
  erDaily: number,
  costFraction = 1
): number {
  const swapSpreadDaily = getSwapSpreadDaily(smaIndex, borrowRate, leverage);
  return leverage * indexReturn
    - erDaily * costFraction
    - (Math.abs(leverage) - 1) * (borrowRate + swapSpreadDaily) * costFraction;
}

function sliceBacktestResultToWindow(
  result: BacktestResult,
  displayStartIdx: number,
  configs: EtfConfig[],
): BacktestResult {
  if (displayStartIdx <= 0) return result;

  const datesSlice = result.dates.slice(displayStartIdx);
  if (datesSlice.length < 2) return result;

  const nonLeveragedValues = renormalizeSeriesFromIndex(result.nonLeveragedValues, displayStartIdx);
  const investedValues = result.investedValues.slice(displayStartIdx);

  const etfResults = result.etfResults.map((etf): EtfResult => {
    const firstDate = datesSlice[0];
    const lastDate = datesSlice[datesSlice.length - 1];

    // Entry spread paid to establish the position at the display window's
    // start — same "carried-in regime, else last signal at-or-before"
    // resolution used when a per-config trim happens later (parallel.ts's
    // trimEtfResultToStartDate), so both paths agree on which spread applies.
    const config = configs.find((c) => c.id === etf.id || etf.id.startsWith(`${c.id}-`));
    const carriedInRiskOff = etf.smaStartInvested === false;
    const { startInRiskOff } = resolveEdgeRiskOffStates(etf.smaSignals, firstDate, lastDate, carriedInRiskOff);
    const entrySpread = config
      ? selectEdgeSpreads(
          {
            riskOnSpreadRegular: getSymbolSpread(config.name, false),
            riskOffSpreadRegular: getRiskOffSpread(config.riskOffAsset, false),
          },
          startInRiskOff,
          startInRiskOff
        ).entrySpread
      : 0;

    const dailyValues = renormalizeSeriesFromIndex(etf.dailyValues, displayStartIdx, entrySpread);
    const finalValue = dailyValues[dailyValues.length - 1] ?? 0;
    const firstDateMs = new Date(`${firstDate}T00:00:00Z`).getTime();
    const lastDateMs = new Date(`${datesSlice[datesSlice.length - 1]}T00:00:00Z`).getTime();

    const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, firstDateMs, lastDateMs);
    const drawdown = calcMaxDrawdownInRange(dailyValues, datesSlice, 0, dailyValues.length - 1);
    const monthlyExtremes = calcMonthlyExtremes(dailyValues, datesSlice);
    const sharpeRatio = calcSharpeRatio(dailyValues);

    // Regime on the window's first day: the last warm-up signal wins; with none,
    // the simulation's start state carries through. Signals are chronological.
    let smaStartInvested = etf.smaStartInvested;
    if (smaStartInvested !== undefined) {
      for (const s of etf.smaSignals) {
        if (s.date >= firstDate) break;
        smaStartInvested = s.type === "buy";
      }
    }

    return {
      ...etf,
      dates: datesSlice,
      dailyValues,
      finalValue,
      cagr,
      sharpeRatio,
      maxDrawdownPct: drawdown.pct,
      maxDrawdownDollar: drawdown.dollar,
      maxDrawdownDates: drawdown.maxDrawdownDates,
      longestDrawdownDays: drawdown.longestDays,
      longestDrawdownDates: drawdown.longestDrawdownDates,
      bestMonth: monthlyExtremes.bestMonth,
      bestMonthDates: monthlyExtremes.bestMonthDates,
      worstMonth: monthlyExtremes.worstMonth,
      worstMonthDates: monthlyExtremes.worstMonthDates,
      smaPrices: etf.smaPrices.length ? etf.smaPrices.slice(displayStartIdx) : etf.smaPrices,
      smaSignals: etf.smaSignals.filter((s) => s.date >= firstDate),
      smaStartInvested,
    };
  });

  return {
    dates: datesSlice,
    nonLeveragedValues,
    investedValues,
    etfResults,
  };
}

/**
 * Run a backtest with exactly `warmUpTradingDays` of SMA warm-up before
 * `displayStartDate`, then slice to the display window.  Both the rolling
 * simulation and the single-backtest page call this so results are identical.
 *
 * `allPrices` must extend far enough before `displayStartDate` to supply the
 * warm-up.  If fewer trading days are available, whatever is available is used.
 */
export function simulateWithWarmUp(
  allPrices: PricePoint[],
  rates: RatePoint[],
  configs: EtfConfig[],
  displayStartDate: string,
  warmUpTradingDays: number,
  options?: {
    riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    etfPricesByName?: Record<string, number[]>;
    etfOpenPricesByName?: Record<string, number[]>;
    endDate?: string;
    onProgress?: (completedUnits: number, totalUnits: number) => void;
  },
): BacktestResult {
  const displayIdx = allPrices.findIndex((p) => p.date >= displayStartDate);
  if (displayIdx < 0) {
    return simulateBacktest(allPrices, rates, configs, options);
  }

  const warmUpOffset = Math.min(warmUpTradingDays, displayIdx);
  const simStartIdx = displayIdx - warmUpOffset;

  // Constrain end to endDate if provided
  let simEndIdx = allPrices.length - 1;
  if (options?.endDate) {
    while (simEndIdx > simStartIdx && allPrices[simEndIdx].date > options.endDate) simEndIdx--;
  }

  const simPrices = allPrices.slice(simStartIdx, simEndIdx + 1);
  const simStartDate = simPrices[0].date;
  const simEndDate = simPrices[simPrices.length - 1].date;
  const simRates = rates.filter((r) => r.date >= simStartDate && r.date <= simEndDate);

  // Slice riskOff arrays to match the simulation price range
  const slicedRiskOff = options?.riskOffValuesByAsset
    ? Object.fromEntries(
        Object.entries(options.riskOffValuesByAsset)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, v!.slice(simStartIdx)])
      ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
    : undefined;
  const slicedRiskOffOpen = options?.riskOffOpenValuesByAsset
    ? Object.fromEntries(
        Object.entries(options.riskOffOpenValuesByAsset)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, v!.slice(simStartIdx)])
      ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
    : undefined;

  // Slice etfPrices arrays to match
  const slicedEtfPrices = options?.etfPricesByName
    ? Object.fromEntries(
        Object.entries(options.etfPricesByName).map(([k, v]) => [k, v.slice(simStartIdx)])
      )
    : undefined;
  const slicedEtfOpenPrices = options?.etfOpenPricesByName
    ? Object.fromEntries(
        Object.entries(options.etfOpenPricesByName).map(([k, v]) => [k, v.slice(simStartIdx)])
      )
    : undefined;

  const result = simulateBacktest(simPrices, simRates, configs, {
    riskOffValuesByAsset: slicedRiskOff,
    riskOffOpenValuesByAsset: slicedRiskOffOpen,
    etfPricesByName: slicedEtfPrices,
    etfOpenPricesByName: slicedEtfOpenPrices,
    onProgress: options?.onProgress,
  });

  return sliceBacktestResultToWindow(result, warmUpOffset, configs);
}

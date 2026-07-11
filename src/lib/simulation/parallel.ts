import type { RollingSimulationPoint } from "./rolling";
import type { EtfConfig, PricePoint, RatePoint, SmaComparisonRow, EtfResult, BacktestResult } from "./types";
import { buildRollingWindows, summarizeSmaRow, type RollingWindow } from "./rolling";
import { buildRateLookup } from "./borrowing-rate";
import { simulateSingleEtf, simulateWithWarmUp, computeSimulatedRiskOnReturn } from "./engine";
import { calcCagr, calcMaxDrawdownInRange, calcSharpeRatio, calcMonthlyExtremes } from "./metrics";
import {
  CONSTANT_HISTORY_WRAP_ENABLED,
  CONSTANT_INITIAL_INVESTMENT,
  LABEL_INDEX_NASDAQ100_TR,
  LABEL_INDEX_SP500_TR,
  getSymbolSpread,
  getRiskOffSpread,
  getTransitionSpreadCost,
} from "../constants";
import { DEFAULT_SMA_EXECUTION_MODE } from "../input-normalization";
import { buildWrappedTailCache, extractCachedWrappedWindowResult, extractOptimizedWrappedWindowResult } from "./wrapped-window";
import { adjustedOpenFromPricePoint, alignCloseSeriesToDates, alignOpenSeriesToDates } from "../utils";
import { getConfigDefaultStartDate } from "./presets";
import {
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  getRangeTradeCount,
  getRangeTradeValueSum,
  selectEdgeSpreads,
} from "./window-calculations";

function alignActualSeriesToDates(
  basePrices: PricePoint[],
  points: PricePoint[],
  getPrice: (point: PricePoint) => number | undefined
): number[] {
  if (points.length === 0) return [];
  const sortedPoints = [...points]
    .filter((point) => {
      const price = getPrice(point);
      return Number.isFinite(price) && (price ?? 0) > 0;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sortedPoints.length === 0) return [];

  let sourceIdx = 0;
  let lastKnownPrice = Number.NaN;
  return basePrices.map((base) => {
    while (sourceIdx < sortedPoints.length && sortedPoints[sourceIdx].date <= base.date) {
      lastKnownPrice = getPrice(sortedPoints[sourceIdx]) as number;
      sourceIdx += 1;
    }
    return lastKnownPrice;
  });
}

function alignActualCloseSeriesToDates(basePrices: PricePoint[], points: PricePoint[]): number[] {
  return alignActualSeriesToDates(basePrices, points, (point) => point.adj_close);
}

function alignActualOpenSeriesToDates(basePrices: PricePoint[], points: PricePoint[]): number[] {
  return alignActualSeriesToDates(basePrices, points, (point) => point.adj_open ?? point.adj_close);
}

/**
 * Pre-computed daily values for a single config across the FULL date range.
 */
interface PrecomputedConfigDailyValues {
  configId: string;
  indexKey: EtfConfig["smaIndex"];
  dailyValues: number[];
  smaSignals?: Array<{ date: string; type: 'buy' | 'sell'; price: number }>;
  smaPrices?: number[];
  timestamps: number[];
  riskOffStateByIndex?: Int8Array;
  nonLeveragedValues?: number[];
  perTransitionSpreadPct?: number;
  /** Set of date-array indices where a trade (SMA signal) occurs */
  tradeDayIndexSet?: Set<number>;
  /** Sorted indices where a trade occurs. Structured-clone friendly. */
  tradeDayIndices?: number[];
  /** Prefix sum of trade counts for O(1) window counts. Length = n + 1. */
  tradeCountPrefix?: Uint32Array;
  /** Prefix sum of transition spread fractions. Length = n + 1. */
  tradeSpreadPrefix?: Float64Array;
  /** Prefix sum of daily values at trade points for O(1) spread-cost lookup. */
  tradeValuePrefix?: Float64Array;
  /** Raw spread fraction (not percentage) for dollar cost computation */
  perTransitionSpreadFraction?: number;
  /** Half-spread for risk-on asset (fraction) */
  riskOnSpread?: number;
  /** Half-spread for risk-off asset (fraction) */
  riskOffSpread?: number;
  /** Regular-hours half-spread for risk-on asset */
  riskOnSpreadRegular?: number;
  /** Regular-hours half-spread for risk-off asset */
  riskOffSpreadRegular?: number;
}

interface ConfigSimulationBucket {
  configId: string;
  simulations: RollingSimulationPoint[];
}

interface VariantSummaryResult {
  label: string;
  summary: SmaComparisonRow;
}

interface IndexSimulationContext {
  indexKey: EtfConfig["smaIndex"];
  prices: PricePoint[];
  dates: string[];
  timestamps: number[];
  borrowingRates: number[];
  indexValues: number[];
  smaClosePrices: number[];
  openPrices: number[];
  indexReturns: number[];
  nonLeveragedValues: number[];
}

const indexContextWeakCache = new WeakMap<PricePoint[], IndexSimulationContext>();

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function logParallelTiming(label: string, startedAt: number): void {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return;
  console.log(`[parallel] ${label}: ${(nowMs() - startedAt).toFixed(1)}ms`);
}

function buildIndexSimulationContext(
  indexKey: EtfConfig["smaIndex"],
  prices: PricePoint[],
  rateLookup: { getRate(date: string): number }
): IndexSimulationContext {
  const cached = indexContextWeakCache.get(prices);
  if (cached) return cached;

  const dates = prices.map((p) => p.date);
  const timestamps = dates.map((date) => new Date(`${date}T00:00:00Z`).getTime());
  const borrowingRates = new Array<number>(prices.length);
  const indexValues = new Array<number>(prices.length);
  const smaClosePrices = new Array<number>(prices.length);
  const openPrices = new Array<number>(prices.length);
  const indexReturns = new Array<number>(prices.length);
  const nonLeveragedValues = new Array<number>(prices.length);

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    borrowingRates[i] = rateLookup.getRate(price.date);
    indexValues[i] = price.adj_close;
    smaClosePrices[i] = price.close;
    openPrices[i] = adjustedOpenFromPricePoint(price);
  }

  indexReturns[0] = 0;
  nonLeveragedValues[0] = CONSTANT_INITIAL_INVESTMENT;
  for (let i = 1; i < prices.length; i++) {
    const prev = indexValues[i - 1];
    const curr = indexValues[i];
    const dailyReturn = prev !== 0 && isFinite(prev) && isFinite(curr)
      ? (curr - prev) / prev
      : 0;
    indexReturns[i] = dailyReturn;
    nonLeveragedValues[i] = nonLeveragedValues[i - 1] * (1 + dailyReturn);
  }

  const context: IndexSimulationContext = {
    indexKey,
    prices,
    dates,
    timestamps,
    borrowingRates,
    indexValues,
    smaClosePrices,
    openPrices,
    indexReturns,
    nonLeveragedValues,
  };
  indexContextWeakCache.set(prices, context);
  return context;
}

function buildTradePrefixes(
  dates: string[],
  dailyValues: number[],
  perTransitionSpreadFraction: number,
  signals?: Array<{ date: string; type: 'buy' | 'sell'; price: number }>
): Pick<PrecomputedConfigDailyValues, "tradeDayIndexSet" | "tradeDayIndices" | "tradeCountPrefix" | "tradeValuePrefix" | "tradeSpreadPrefix"> {
  const tradeDayIndexSet = new Set<number>();
  const dateToIdx = new Map<string, number>();
  for (let i = 0; i < dates.length; i++) {
    dateToIdx.set(dates[i], i);
  }
  for (const signal of signals ?? []) {
    const idx = dateToIdx.get(signal.date);
    if (idx !== undefined) tradeDayIndexSet.add(idx);
  }

  const tradeDayIndices = Array.from(tradeDayIndexSet).sort((a, b) => a - b);
  const tradeCountPrefix = new Uint32Array(dailyValues.length + 1);
  const tradeValuePrefix = new Float64Array(dailyValues.length + 1);
  const tradeSpreadPrefix = new Float64Array(dailyValues.length + 1);

  let tradeCursor = 0;
  for (let i = 0; i < dailyValues.length; i++) {
    tradeCountPrefix[i + 1] = tradeCountPrefix[i];
    tradeValuePrefix[i + 1] = tradeValuePrefix[i];
    tradeSpreadPrefix[i + 1] = tradeSpreadPrefix[i];

    if (tradeCursor < tradeDayIndices.length && tradeDayIndices[tradeCursor] === i) {
      tradeCountPrefix[i + 1] += 1;
      tradeValuePrefix[i + 1] += dailyValues[i];
      tradeSpreadPrefix[i + 1] += perTransitionSpreadFraction;
      tradeCursor++;
    }
  }

  return {
    tradeDayIndexSet,
    tradeDayIndices,
    tradeCountPrefix,
    tradeValuePrefix,
    tradeSpreadPrefix,
  };
}

function buildRiskOffStateByIndex(
  dates: string[],
  signals?: Array<{ date: string; type: 'buy' | 'sell'; price: number }>
): Int8Array | undefined {
  if (!signals || signals.length === 0) return undefined;
  const state = new Int8Array(dates.length);
  let signalIndex = 0;
  let inRiskOff = false;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    while (signalIndex < signals.length && signals[signalIndex].date <= date) {
      inRiskOff = signals[signalIndex].type === "sell";
      signalIndex += 1;
    }
    state[i] = inRiskOff ? 1 : 0;
  }
  return state;
}

function isRiskOffAt(precomputed: PrecomputedConfigDailyValues, index: number): boolean {
  return precomputed.riskOffStateByIndex?.[index] === 1;
}

function extractRegularWindowSimulation(
  precomputed: PrecomputedConfigDailyValues,
  window: RollingWindow
): RollingSimulationPoint | null {
  const startIdx = window.startIdx;
  const endIdx = window.endIdx;
  const metrics = computeRenormalizedPathMetrics(precomputed.dailyValues, startIdx, endIdx);
  if (!metrics || !isFinite(metrics.finalValue)) return null;

  const nonLeveragedMetrics = computeOptionalNonLeveragedMetrics(precomputed.nonLeveragedValues, startIdx, endIdx);
  const { entrySpread, exitSpread } = selectEdgeSpreads(
    precomputed,
    isRiskOffAt(precomputed, startIdx),
    isRiskOffAt(precomputed, endIdx)
  );
  const spreadFrac = precomputed.perTransitionSpreadFraction ?? 0;
  const internalDollarCost = spreadFrac > 0
    ? metrics.factor * spreadFrac * getRangeTradeValueSum(precomputed, startIdx, endIdx)
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
    precomputed.timestamps[startIdx],
    precomputed.timestamps[endIdx],
    window.startDate,
    window.endDate
  );

  return {
    startDate: window.startDate,
    endDate: window.endDate,
    finalValue: tradingCosts.finalValue,
    nonLeveragedFinalValue: nonLeveragedMetrics.finalValue,
    maxDrawdownPct: metrics.maxDrawdownPct * 100,
    nonLeveragedMaxDrawdownPct: nonLeveragedMetrics.maxDrawdownPct * 100,
    cagr,
    totalReturnPct: ((tradingCosts.finalValue - CONSTANT_INITIAL_INVESTMENT) / CONSTANT_INITIAL_INVESTMENT) * 100,
    tradeCount: getRangeTradeCount(precomputed, startIdx, endIdx),
    totalTradingCostPct: tradingCosts.totalTradingCostPct,
    usedHistoryWrap: false,
  };
}

/**
 * Build pre-computed leveraged risk-on daily returns for a given index context.
 * In a sweep, all configs share leverage/ER/index, so this array is computed once
 * and reused across all configs — saving ~53 redundant computeSimulatedRiskOnReturn
 * calls per day per sweep.
 */
function buildPrecomputedRiskOnReturns(
  context: IndexSimulationContext,
  leverage: number,
  expenseRatio: number,
): number[] {
  const erDaily = expenseRatio / 100 / 252;
  const returns = new Array<number>(context.indexReturns.length);
  returns[0] = 0;
  for (let i = 1; i < context.indexReturns.length; i++) {
    returns[i] = computeSimulatedRiskOnReturn(
      context.indexReturns[i],
      context.borrowingRates[i],
      context.indexKey,
      leverage,
      erDaily
    );
  }
  return returns;
}

/**
 * Pre-compute ALL daily values for ALL configs in the main thread.
 * Exported for use by the snapshot generator.
 * Workers will just slice windows from this data - NO simulation needed!
 */
export function precomputeAllConfigDailyValues(
  prices: PricePoint[],
  rates: RatePoint[],
  configs: EtfConfig[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  etfPricesByName?: Record<string, number[]>,
  etfOpenPricesByName?: Record<string, number[]>,
  pricesByIndex?: Record<string, PricePoint[]>,
  onProgress?: (completedUnits: number, totalUnits: number, label?: string) => void
): PrecomputedConfigDailyValues[] {
  const rateLookup = buildRateLookup(rates);
  const indexContextByKey = new Map<EtfConfig["smaIndex"], IndexSimulationContext>();
  const totalUnits = configs.reduce((sum, config) => {
    const configPrices = pricesByIndex?.[config.smaIndex] ?? prices;
    return sum + Math.max(1, configPrices.length - 1);
  }, 0);
  let completedUnits = 0;

  // Pre-compute risk-on returns once per unique (index, leverage, ER) combination.
  // In a sweep all configs share these — avoids redundant computation.
  const riskOnReturnsByKey = new Map<string, number[]>();

  const results: PrecomputedConfigDailyValues[] = [];

  for (const config of configs) {
    const configPrices = pricesByIndex?.[config.smaIndex] ?? prices;
    let context = indexContextByKey.get(config.smaIndex);
    if (!context || context.prices !== configPrices) {
      context = buildIndexSimulationContext(config.smaIndex, configPrices, rateLookup);
      indexContextByKey.set(config.smaIndex, context);
    }

    // Reuse pre-computed risk-on returns for simulated configs with same leverage/ER/index
    const riskOnKey = config.simulated ? `${config.smaIndex}|${config.leverage}|${config.expenseRatio}` : "";
    let precomputedRiskOnReturns: number[] | undefined;
    if (config.simulated && riskOnKey) {
      precomputedRiskOnReturns = riskOnReturnsByKey.get(riskOnKey);
      if (!precomputedRiskOnReturns) {
        precomputedRiskOnReturns = buildPrecomputedRiskOnReturns(context, config.leverage, config.expenseRatio);
        riskOnReturnsByKey.set(riskOnKey, precomputedRiskOnReturns);
      }
    }

    const result = simulateSingleEtf(
      config,
      context.dates,
      context.indexValues,
      context.indexReturns,
      context.openPrices,
      context.smaClosePrices,
      context.borrowingRates,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      etfPricesByName,
      etfOpenPricesByName,
      (completedSteps, totalSteps) => {
        onProgress?.(
          completedUnits + Math.min(completedSteps, totalSteps),
          totalUnits,
          "Running simulations..."
        );
      },
      { skipMetrics: true, precomputedRiskOnReturns }
    );
    completedUnits += Math.max(1, context.dates.length - 1);
    onProgress?.(completedUnits, totalUnits, "Running simulations...");

    // Compute per-transition spread cost for this config
    const afterHours = (config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE) === "trigger-day-close";
    const riskOnSpread = getSymbolSpread(config.name, afterHours);
    const riskOffSpread = getRiskOffSpread(config.riskOffAsset, afterHours);
    
    // Regular hour liquidation spreads (forced false for afterHours)
    const riskOnSpreadRegular = getSymbolSpread(config.name, false);
    const riskOffSpreadRegular = getRiskOffSpread(config.riskOffAsset, false);

    const perTransitionSpreadFraction = config.smaEnabled
      ? riskOnSpread + riskOffSpread
      : 0;
    const perTransitionSpreadPct = perTransitionSpreadFraction * 100;

    const tradeMetadata = buildTradePrefixes(context.dates, result.dailyValues, perTransitionSpreadFraction, result.smaSignals);
    const riskOffStateByIndex = buildRiskOffStateByIndex(context.dates, result.smaSignals);

    results.push({
      configId: config.id,
      indexKey: config.smaIndex,
      dailyValues: result.dailyValues,
      smaSignals: result.smaSignals?.map((s: { date: string; type: string; price: number }) => ({
        date: s.date,
        type: s.type as 'buy' | 'sell',
        price: s.price
      })),
      smaPrices: result.smaPrices,
      timestamps: context.timestamps,
      riskOffStateByIndex,
      nonLeveragedValues: context.nonLeveragedValues,
      perTransitionSpreadPct,
      perTransitionSpreadFraction,
      riskOnSpread,
      riskOffSpread,
      riskOnSpreadRegular,
      riskOffSpreadRegular,
      ...tradeMetadata,
    });
  }

  return results;
}

async function precomputeAllConfigDailyValuesAsync(
  prices: PricePoint[],
  rates: RatePoint[],
  configs: EtfConfig[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  etfPricesByName?: Record<string, number[]>,
  etfOpenPricesByName?: Record<string, number[]>,
  pricesByIndex?: Record<string, PricePoint[]>,
  onProgress?: (completedUnits: number, totalUnits: number, label?: string) => void,
  signal?: AbortSignal
): Promise<PrecomputedConfigDailyValues[]> {
  const rateLookup = buildRateLookup(rates);
  const indexContextByKey = new Map<EtfConfig["smaIndex"], IndexSimulationContext>();
  const totalUnits = configs.reduce((sum, config) => {
    const configPrices = pricesByIndex?.[config.smaIndex] ?? prices;
    return sum + Math.max(1, configPrices.length - 1);
  }, 0);
  let completedUnits = 0;

  // Pre-compute risk-on returns once per unique (index, leverage, ER) combination
  const riskOnReturnsByKey = new Map<string, number[]>();

  const results: PrecomputedConfigDailyValues[] = [];

  for (let configIndex = 0; configIndex < configs.length; configIndex += 1) {
    assertNotAborted(signal);
    const config = configs[configIndex];
    const configPrices = pricesByIndex?.[config.smaIndex] ?? prices;
    let context = indexContextByKey.get(config.smaIndex);
    if (!context || context.prices !== configPrices) {
      context = buildIndexSimulationContext(config.smaIndex, configPrices, rateLookup);
      indexContextByKey.set(config.smaIndex, context);
    }

    // Reuse pre-computed risk-on returns for simulated configs with same leverage/ER/index
    const riskOnKey = config.simulated ? `${config.smaIndex}|${config.leverage}|${config.expenseRatio}` : "";
    let precomputedRiskOnReturns: number[] | undefined;
    if (config.simulated && riskOnKey) {
      precomputedRiskOnReturns = riskOnReturnsByKey.get(riskOnKey);
      if (!precomputedRiskOnReturns) {
        precomputedRiskOnReturns = buildPrecomputedRiskOnReturns(context, config.leverage, config.expenseRatio);
        riskOnReturnsByKey.set(riskOnKey, precomputedRiskOnReturns);
      }
    }

    const result = simulateSingleEtf(
      config,
      context.dates,
      context.indexValues,
      context.indexReturns,
      context.openPrices,
      context.smaClosePrices,
      context.borrowingRates,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      etfPricesByName,
      etfOpenPricesByName,
      (completedSteps, totalSteps) => {
        onProgress?.(
          completedUnits + Math.min(completedSteps, totalSteps),
          totalUnits,
          `Running simulations (${configIndex + 1}/${configs.length})...`
        );
      },
      { skipMetrics: true, precomputedRiskOnReturns }
    );
    completedUnits += Math.max(1, context.dates.length - 1);
    onProgress?.(completedUnits, totalUnits, `Running simulations (${configIndex + 1}/${configs.length})...`);

    const afterHours = (config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE) === "trigger-day-close";
    const riskOnSpread = getSymbolSpread(config.name, afterHours);
    const riskOffSpread = getRiskOffSpread(config.riskOffAsset, afterHours);
    
    // Regular hour liquidation spreads (forced false for afterHours)
    const riskOnSpreadRegular = getSymbolSpread(config.name, false);
    const riskOffSpreadRegular = getRiskOffSpread(config.riskOffAsset, false);

    const perTransitionSpreadFraction = config.smaEnabled
      ? riskOnSpread + riskOffSpread
      : 0;
    const perTransitionSpreadPct = perTransitionSpreadFraction * 100;

    const tradeMetadata = buildTradePrefixes(context.dates, result.dailyValues, perTransitionSpreadFraction, result.smaSignals);
    const riskOffStateByIndex = buildRiskOffStateByIndex(context.dates, result.smaSignals);

    results.push({
      configId: config.id,
      indexKey: config.smaIndex,
      dailyValues: result.dailyValues,
      smaSignals: result.smaSignals?.map((s: { date: string; type: string; price: number }) => ({
        date: s.date,
        type: s.type as 'buy' | 'sell',
        price: s.price
      })),
      smaPrices: result.smaPrices,
      timestamps: context.timestamps,
      riskOffStateByIndex,
      nonLeveragedValues: context.nonLeveragedValues,
      perTransitionSpreadPct,
      perTransitionSpreadFraction,
      riskOnSpread,
      riskOffSpread,
      riskOnSpreadRegular,
      riskOffSpreadRegular,
      ...tradeMetadata,
    });

    if (configIndex < configs.length - 1 && configIndex % 2 === 1) {
      await yieldToBrowser();
    }
  }

  return results;
}

type WorkerKind = "regular" | "wrapped";
const SHOULD_REUSE_WORKERS = process.env.NODE_ENV === "production";

interface PooledWorkerEntry {
  worker: Worker;
  busy: boolean;
}

const workerPools: Record<WorkerKind, PooledWorkerEntry[]> = {
  regular: [],
  wrapped: [],
};

function shouldYieldToBrowser(): boolean {
  return typeof window !== "undefined";
}

function yieldToBrowser(): Promise<void> {
  if (!shouldYieldToBrowser()) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Aborted", "AbortError");
}

function createWorker(kind: WorkerKind): Worker {
  return kind === "wrapped"
    ? new Worker(new URL("./wrapped-worker.ts", import.meta.url))
    : new Worker(new URL("./worker.ts", import.meta.url));
}

function acquireWorker(kind: WorkerKind): PooledWorkerEntry {
  if (!SHOULD_REUSE_WORKERS) {
    return { worker: createWorker(kind), busy: true };
  }
  const idle = workerPools[kind].find((entry) => !entry.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  const entry: PooledWorkerEntry = { worker: createWorker(kind), busy: true };
  workerPools[kind].push(entry);
  return entry;
}

function releaseWorker(kind: WorkerKind, entry: PooledWorkerEntry, discard = false): void {
  if (!SHOULD_REUSE_WORKERS) {
    entry.worker.terminate();
    return;
  }
  entry.busy = false;
  entry.worker.onmessage = null;
  entry.worker.onerror = null;
  if (!discard) return;

  entry.worker.terminate();
  const pool = workerPools[kind];
  const idx = pool.indexOf(entry);
  if (idx >= 0) pool.splice(idx, 1);
}

/**
 * Extract rolling window results from pre-computed daily values.
 * NO simulation - just slicing and metrics!
 * Exported for use by the snapshot generator.
 */
export function buildSimulationBuckets(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  options?: {
    rates?: RatePoint[];
    configs?: EtfConfig[];
    riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    pricesByIndex?: Record<string, PricePoint[]>;
  }
): ConfigSimulationBucket[] {
  const buckets: ConfigSimulationBucket[] = [];
  const configById = new Map(options?.configs?.map((config) => [config.id, config]) ?? []);

  for (const precomputed of precomputedDailyValues) {
    const simulations: RollingSimulationPoint[] = [];
    const config = configById.get(precomputed.configId);
    const wrappedTailCache = config && options?.rates
      ? buildWrappedTailCache(
          windows,
          prices,
          config,
          options.rates,
          options.riskOffValuesByAsset,
          options.riskOffOpenValuesByAsset
        )
      : null;

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      if (window.usesSyntheticTail && config && options?.rates) {
        const simulation = wrappedTailCache
          ? extractCachedWrappedWindowResult(precomputed, window, prices, wrappedTailCache)
          : extractOptimizedWrappedWindowResult(
              precomputed,
              window,
              prices,
              config,
              options.rates,
              options.riskOffValuesByAsset,
              options.riskOffOpenValuesByAsset
            );
        if (simulation) simulations.push(simulation);
        continue;
      }
      const simulation = extractRegularWindowSimulation(precomputed, window);
      if (simulation) simulations.push(simulation);
    }

    buckets.push({
      configId: precomputed.configId,
      simulations,
    });
  }

  return buckets;
}

async function buildSimulationBucketsAsync(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  options?: {
    rates?: RatePoint[];
    configs?: EtfConfig[];
    riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    pricesByIndex?: Record<string, PricePoint[]>;
  },
  onProgress?: (completed: number, total: number, label?: string) => void,
  signal?: AbortSignal
): Promise<ConfigSimulationBucket[]> {
  const buckets: ConfigSimulationBucket[] = [];
  const configById = new Map(options?.configs?.map((config) => [config.id, config]) ?? []);

  for (let configIndex = 0; configIndex < precomputedDailyValues.length; configIndex += 1) {
    assertNotAborted(signal);
    const precomputed = precomputedDailyValues[configIndex];
    const simulations: RollingSimulationPoint[] = [];
    const config = configById.get(precomputed.configId);
    const wrappedTailCache = config && options?.rates
      ? buildWrappedTailCache(
          windows,
          prices,
          config,
          options.rates,
          options.riskOffValuesByAsset,
          options.riskOffOpenValuesByAsset
        )
      : null;

    for (let i = 0; i < windows.length; i++) {
      const window = windows[i];
      if (window.usesSyntheticTail && config && options?.rates) {
        const simulation = wrappedTailCache
          ? extractCachedWrappedWindowResult(precomputed, window, prices, wrappedTailCache)
          : extractOptimizedWrappedWindowResult(
              precomputed,
              window,
              prices,
              config,
              options.rates,
              options.riskOffValuesByAsset,
              options.riskOffOpenValuesByAsset
            );
        if (simulation) simulations.push(simulation);
        continue;
      }
      const simulation = extractRegularWindowSimulation(precomputed, window);
      if (simulation) simulations.push(simulation);
    }

    buckets.push({
      configId: precomputed.configId,
      simulations,
    });
    onProgress?.(configIndex + 1, precomputedDailyValues.length, `Preparing results (${configIndex + 1}/${precomputedDailyValues.length})...`);

    if (configIndex < precomputedDailyValues.length - 1 && configIndex % 2 === 1) {
      await yieldToBrowser();
    }
  }

  return buckets;
}

function extractWindowResults(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  warmUpOffsets: number[],
  prices: PricePoint[],
  monthlyCpi?: Array<{ date: string; value: number }>,
  options?: {
    rates?: RatePoint[];
    configs?: EtfConfig[];
    riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
    pricesByIndex?: Record<string, PricePoint[]>;
  }
): SmaComparisonRow[] {
  void warmUpOffsets;
  return buildSimulationBuckets(
    precomputedDailyValues,
    windows,
    prices,
    options
  )
    .filter((bucket) => bucket.simulations.length > 0)
    .map((bucket) => {
      const paramValue = parseFloat(bucket.configId.split('-')[1] || '0');
      return summarizeSmaRow(paramValue, bucket.simulations, monthlyCpi);
    });
}

/**
 * ULTRA-OPTIMIZED: Run multiple EtfConfig configs in parallel.
 */
export async function runParallelSimulations({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  configs,
  labels,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
  monthlyCpi,
  mode,
  etfPricesByName,
  pricesByIndex,
  onProgress,
  signal,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  configs: EtfConfig[];
  labels?: string[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  monthlyCpi?: Array<{ date: string; value: number }>;
  mode: 'sweep' | 'variants' | 'variant-summaries' | 'backtest';
  etfPricesByName?: Record<string, number[]>;
  pricesByIndex?: Record<string, PricePoint[]>;
  onProgress?: (completedFraction: number, label?: string) => void;
  signal?: AbortSignal;
}): Promise<SmaComparisonRow[] | Array<{ label: string; simulations: RollingSimulationPoint[] }> | VariantSummaryResult[] | EtfResult[]> {
  const totalStartedAt = nowMs();
  const precomputeStartedAt = nowMs();
  const precomputedDailyValues = await precomputeAllConfigDailyValuesAsync(
    prices,
    rates,
    configs,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    etfPricesByName,
    undefined,
    pricesByIndex,
    (completedUnits, totalUnits, label) => {
      const fraction = totalUnits > 0 ? completedUnits / totalUnits : 1;
      onProgress?.(fraction * 0.8, label);
    },
    signal
  );
  logParallelTiming("precompute daily values", precomputeStartedAt);

  const windowsStartedAt = nowMs();
  let windows = buildRollingWindows({
    prices,
    windowLength: windowLength || 0,
    startDateConstraint: startDate,
    endDateConstraint: endDate,
    historyWrap,
  });

  // For backtest mode, if no rolling windows are built, we need at least one window for the full range
  if (windows.length === 0 && (mode === 'backtest' || !windowLength)) {
    const startIdx = Math.max(0, prices.findIndex(p => p.date >= startDate));
    // Respect endDate constraint — find the last price on or before endDate
    let endIdx = prices.length - 1;
    if (endDate) {
      while (endIdx > startIdx && prices[endIdx].date > endDate) endIdx--;
    }
    if (endIdx >= startIdx) {
      windows = [{
        startIdx,
        endIdx,
        startDate: prices[startIdx].date,
        endDate: prices[endIdx].date,
        lastRealEndDate: prices[endIdx].date,
        usesSyntheticTail: false,
      }];
    }
  }
  logParallelTiming(`build ${windows.length} rolling windows`, windowsStartedAt);

  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const numWorkers = Math.min(hwConcurrency || 4, configs.length);
  const hasWrappedWindows = windows.some((window) => window.usesSyntheticTail);
  const workersUnavailable = typeof Worker === "undefined";
  const shouldRunMainThreadOnly =
    workersUnavailable ||
    numWorkers <= 1 ||
    (configs.length === 1 && windows.length < 500);

  if (shouldRunMainThreadOnly) {
    const extractionStartedAt = nowMs();
    const result = await extractResultsMainThreadAsync(
      precomputedDailyValues,
      windows,
      prices,
      monthlyCpi,
      mode,
      configs,
      labels,
      pricesByIndex,
      rates,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      (fraction, label) => onProgress?.(0.8 + fraction * 0.2, label),
      signal
    );
    logParallelTiming("main-thread extraction", extractionStartedAt);
    logParallelTiming("TOTAL", totalStartedAt);
    return result;
  }

  if (hasWrappedWindows && mode !== 'backtest') {
    const wrappedStartedAt = nowMs();
    const nonWrappedWindows = windows.filter((window) => !window.usesSyntheticTail);
    const wrappedWindows = windows.filter((window) => window.usesSyntheticTail);
    const workerBuckets = nonWrappedWindows.length > 0
      ? await runWorkerSimulationBuckets({
          precomputedDailyValues,
          windows: nonWrappedWindows,
          prices,
          configs,
          pricesByIndex,
        })
      : [];
    const wrappedBuckets = wrappedWindows.length > 0
      ? await runWrappedWorkerSimulationBuckets({
          precomputedDailyValues,
          windows: wrappedWindows,
          prices,
          rates,
          configs,
          riskOffValuesByAsset,
          riskOffOpenValuesByAsset,
        })
      : [];

    onProgress?.(0.95, "Preparing results...");

    const combinedBuckets = configs.map((config) => {
      const workerSimulations =
        workerBuckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [];
      const wrappedSimulations =
        wrappedBuckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [];
      return {
        configId: config.id,
        simulations: [...workerSimulations, ...wrappedSimulations],
      };
    });

    if (mode === 'sweep' || mode === 'variant-summaries') {
      const result = combinedBuckets
        .filter((bucket) => bucket.simulations.length > 0)
        .map((bucket) => {
          const paramValue = parseFloat(bucket.configId.split('-')[1] || '0');
          const summary = summarizeSmaRow(paramValue, bucket.simulations, monthlyCpi);
          if (mode === 'variant-summaries') {
            const index = configs.findIndex((config) => config.id === bucket.configId);
            return {
              label: labels?.[index] ?? bucket.configId,
              summary,
            };
          }
          return summary;
      });
      onProgress?.(1, "Preparing results...");
      logParallelTiming("wrapped extraction", wrappedStartedAt);
      logParallelTiming("TOTAL", totalStartedAt);
      return result as SmaComparisonRow[] | VariantSummaryResult[];
    }

    const result = combinedBuckets.map((bucket, index) => ({
      label: labels ? labels[index] : configs[index].id,
      simulations: bucket.simulations,
    }));
    onProgress?.(1, "Preparing results...");
    logParallelTiming("wrapped extraction", wrappedStartedAt);
    logParallelTiming("TOTAL", totalStartedAt);
    return result;
  }

  const workerStartedAt = nowMs();
  const configsPerWorker = Math.ceil(configs.length / numWorkers);
  const workerPromises = [];

  for (let i = 0; i < numWorkers; i++) {
    const sIdx = i * configsPerWorker;
    const eIdx = Math.min(sIdx + configsPerWorker, configs.length);
    if (sIdx >= eIdx) break;

    const workerConfigs = configs.slice(sIdx, eIdx);
    const workerLabels = labels ? labels.slice(sIdx, eIdx) : undefined;
    const workerPrecomputed = precomputedDailyValues.filter(p => 
      workerConfigs.some(c => c.id === p.configId)
    );

    workerPromises.push(runWorkerTask({
      precomputedDailyValues: workerPrecomputed,
      windows,
      prices,
      monthlyCpi,
      mode: mode as 'sweep' | 'variants' | 'variant-summaries' | 'backtest',
      configs: workerConfigs,
      labels: workerLabels
    }));
  }

  const workerResults = [];
  for (let i = 0; i < workerPromises.length; i += 1) {
    workerResults.push(await workerPromises[i]);
    const fraction = workerPromises.length > 0 ? (i + 1) / workerPromises.length : 1;
    onProgress?.(0.85 + fraction * 0.15, "Preparing results...");
  }
  
  const result = (workerResults as EtfResult[][]).flat();
  logParallelTiming("worker extraction", workerStartedAt);
  logParallelTiming("TOTAL", totalStartedAt);
  return result;
}

async function runWorkerSimulationBuckets(data: {
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  configs: EtfConfig[];
  pricesByIndex?: Record<string, PricePoint[]>;
}): Promise<ConfigSimulationBucket[]> {
  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const numWorkers = Math.min(hwConcurrency || 4, data.configs.length);
  const configsPerWorker = Math.ceil(data.configs.length / numWorkers);
  const workerPromises: Array<Promise<ConfigSimulationBucket[]>> = [];

  for (let i = 0; i < numWorkers; i++) {
    const sIdx = i * configsPerWorker;
    const eIdx = Math.min(sIdx + configsPerWorker, data.configs.length);
    if (sIdx >= eIdx) break;

    const workerConfigs = data.configs.slice(sIdx, eIdx);
    const workerPrecomputed = data.precomputedDailyValues.filter((precomputed) =>
      workerConfigs.some((config) => config.id === precomputed.configId)
    );

    workerPromises.push(runWorkerTask({
      precomputedDailyValues: workerPrecomputed,
      windows: data.windows,
      prices: data.prices,
      mode: 'simulation-buckets',
      configs: workerConfigs,
      pricesByIndex: data.pricesByIndex,
    }) as Promise<ConfigSimulationBucket[]>);
  }

  return (await Promise.all(workerPromises)).flat();
}

async function runWrappedWorkerSimulationBuckets(data: {
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  rates: RatePoint[];
  configs: EtfConfig[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}): Promise<ConfigSimulationBucket[]> {
  const hwConcurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const numWorkers = Math.min(hwConcurrency || 4, data.configs.length);
  const configsPerWorker = Math.ceil(data.configs.length / numWorkers);
  const workerPromises: Array<Promise<ConfigSimulationBucket[]>> = [];

  for (let i = 0; i < numWorkers; i++) {
    const sIdx = i * configsPerWorker;
    const eIdx = Math.min(sIdx + configsPerWorker, data.configs.length);
    if (sIdx >= eIdx) break;

    const workerConfigs = data.configs.slice(sIdx, eIdx);
    const workerPrecomputed = data.precomputedDailyValues.filter((precomputed) =>
      workerConfigs.some((config) => config.id === precomputed.configId)
    );

    workerPromises.push(runWrappedWorkerTask({
      precomputedDailyValues: workerPrecomputed,
      windows: data.windows,
      prices: data.prices,
      rates: data.rates,
      configs: workerConfigs,
      riskOffValuesByAsset: data.riskOffValuesByAsset,
      riskOffOpenValuesByAsset: data.riskOffOpenValuesByAsset,
    }));
  }

  return (await Promise.all(workerPromises)).flat();
}

async function runWorkerTask(data: {
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  monthlyCpi?: Array<{ date: string; value: number }>;
  mode: 'sweep' | 'variants' | 'variant-summaries' | 'backtest' | 'simulation-buckets';
  configs: EtfConfig[];
  labels?: string[];
  pricesByIndex?: Record<string, PricePoint[]>;
}): Promise<SmaComparisonRow[] | Array<{ label: string; simulations: RollingSimulationPoint[] }> | VariantSummaryResult[] | EtfResult[] | ConfigSimulationBucket[]> {
  return new Promise((resolve, reject) => {
    const entry = acquireWorker("regular");
    const worker = entry.worker;

    worker.onmessage = (e) => {
      if (e.data.type === 'result') {
        resolve(e.data.result);
        releaseWorker("regular", entry);
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message));
        releaseWorker("regular", entry, true);
      }
    };

    worker.onerror = (e) => {
      reject(e);
      releaseWorker("regular", entry, true);
    };

    const serializableData = {
      ...data,
      precomputedDailyValues: data.precomputedDailyValues.map((precomputed) => {
        const { tradeDayIndexSet, ...rest } = precomputed;
        void tradeDayIndexSet;
        return rest;
      }),
      mode: 'extract-windows',
      mode_type: data.mode,
    };
    worker.postMessage(serializableData);
  });
}

async function runWrappedWorkerTask(data: {
  precomputedDailyValues: PrecomputedConfigDailyValues[];
  windows: RollingWindow[];
  prices: PricePoint[];
  rates: RatePoint[];
  configs: EtfConfig[];
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
}): Promise<ConfigSimulationBucket[]> {
  return new Promise((resolve, reject) => {
    const entry = acquireWorker("wrapped");
    const worker = entry.worker;

    worker.onmessage = (e) => {
      if (e.data.type === 'result') {
        resolve(e.data.result);
        releaseWorker("wrapped", entry);
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message));
        releaseWorker("wrapped", entry, true);
      }
    };

    worker.onerror = (e) => {
      reject(e);
      releaseWorker("wrapped", entry, true);
    };

    const serializableData = {
      ...data,
      precomputedDailyValues: data.precomputedDailyValues.map((precomputed) => {
        const { tradeDayIndexSet, ...rest } = precomputed;
        void tradeDayIndexSet;
        return { ...rest };
      }),
    };
    worker.postMessage(serializableData);
  });
}

function extractResultsMainThread(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  monthlyCpi: Array<{ date: string; value: number }> | undefined,
  mode: 'sweep' | 'variants' | 'variant-summaries' | 'backtest',
  configs: EtfConfig[],
  labels?: string[],
  pricesByIndex?: Record<string, PricePoint[]>,
  rates?: RatePoint[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>
): SmaComparisonRow[] | Array<{ label: string; simulations: RollingSimulationPoint[] }> | VariantSummaryResult[] | EtfResult[] {
  if (mode === 'sweep') {
    return extractWindowResults(precomputedDailyValues, windows, [], prices, monthlyCpi, {
      rates,
      configs,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      pricesByIndex,
    });
  } else if (mode === 'variants' || mode === 'variant-summaries') {
    const buckets = buildSimulationBuckets(precomputedDailyValues, windows, prices, {
      rates,
      configs,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      pricesByIndex,
    });
    if (mode === 'variant-summaries') {
      return configs.map((config, index) => ({
        label: labels ? labels[index] : config.id,
        summary: summarizeSmaRow(0, buckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [], monthlyCpi),
      }));
    }
    return configs.map((config, index) => ({
      label: labels ? labels[index] : config.id,
      simulations: buckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [],
    }));
  } else {
    // backtest
    const startIdx = windows[0].startIdx;
    const endIdx = windows[0].endIdx;
    return configs.map(config => {
      const precomputed = precomputedDailyValues.find(p => p.configId === config.id)!;
      
      // Use the correct dates for this config's smaIndex
      const configPrices = pricesByIndex?.[config.smaIndex] ?? prices;
      const configDates = configPrices.map(p => p.date);
      const configTimestamps = precomputed.timestamps;

      const factor = CONSTANT_INITIAL_INVESTMENT / precomputed.dailyValues[startIdx];
      const renormalizedDaily = precomputed.dailyValues.slice(startIdx, endIdx + 1).map(v => v * factor);
      
      const rawFinalValue = renormalizedDaily[renormalizedDaily.length - 1];
      const isSma = precomputed.smaSignals !== undefined && precomputed.smaSignals.length > 0;
      const endInRiskOff = isSma && isRiskOffAt(precomputed, endIdx);
      const { exitSpread } = selectEdgeSpreads(precomputed, false, endInRiskOff);
      const exitDollarCost = rawFinalValue * exitSpread;
      const finalValue = Math.max(0, rawFinalValue - exitDollarCost);

      const dd = calcMaxDrawdownInRange(precomputed.dailyValues, configDates, startIdx, endIdx);
      const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, configTimestamps[startIdx], configTimestamps[endIdx], windows[0].startDate, windows[0].endDate);
      const sharpeRatio = calcSharpeRatio(renormalizedDaily);
      const monthlyExtremes = calcMonthlyExtremes(renormalizedDaily, configDates.slice(startIdx, endIdx + 1));

      return {
        id: config.id,
        name: config.name,
        sourceIndex: config.smaIndex,
        dates: configDates.slice(startIdx, endIdx + 1),
        dailyValues: renormalizedDaily,
        finalValue,
        cagr,
        sharpeRatio,
        maxDrawdownPct: dd.pct,
        maxDrawdownDollar: dd.dollar,
        maxDrawdownDates: dd.maxDrawdownDates,
        longestDrawdownDays: dd.longestDays,
        longestDrawdownDates: dd.longestDrawdownDates,
        bestMonth: monthlyExtremes.bestMonth,
        bestMonthDates: monthlyExtremes.bestMonthDates,
        worstMonth: monthlyExtremes.worstMonth,
        worstMonthDates: monthlyExtremes.worstMonthDates,
        smaSignals: precomputed.smaSignals?.filter(s => s.date >= configDates[startIdx] && s.date <= configDates[endIdx]) || [],
        smaPrices: precomputed.smaPrices?.slice(startIdx, endIdx + 1) || [],
        totalTradingCostPct: (() => {
          if (finalValue <= 0) return 0;
          const sf = precomputed.perTransitionSpreadFraction ?? 0;
          const { entrySpread } = selectEdgeSpreads(precomputed, isSma && isRiskOffAt(precomputed, startIdx), endInRiskOff);
          
          const internalCost = sf > 0 ? factor * sf * getRangeTradeValueSum(precomputed, startIdx, endIdx) : 0;
          return finalizeTradingCosts({
            rawFinalValue,
            entrySpread,
            exitSpread,
            internalDollarCost: internalCost,
          }).totalTradingCostPct;
        })(),
      };
    });
  }
}

async function extractResultsMainThreadAsync(
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  windows: RollingWindow[],
  prices: PricePoint[],
  monthlyCpi: Array<{ date: string; value: number }> | undefined,
  mode: 'sweep' | 'variants' | 'variant-summaries' | 'backtest',
  configs: EtfConfig[],
  labels?: string[],
  pricesByIndex?: Record<string, PricePoint[]>,
  rates?: RatePoint[],
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  onProgress?: (completedFraction: number, label?: string) => void,
  signal?: AbortSignal
): Promise<SmaComparisonRow[] | Array<{ label: string; simulations: RollingSimulationPoint[] }> | VariantSummaryResult[] | EtfResult[]> {
  if (mode === 'backtest') {
    const result = extractResultsMainThread(
      precomputedDailyValues,
      windows,
      prices,
      monthlyCpi,
      mode,
      configs,
      labels,
      pricesByIndex,
      rates,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset
    );
    onProgress?.(1, "Preparing results...");
    return result;
  }

  const buckets = await buildSimulationBucketsAsync(
    precomputedDailyValues,
    windows,
    prices,
    {
      rates,
      configs,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset,
      pricesByIndex,
    },
    (completed, total, label) => {
      const fraction = total > 0 ? completed / total : 1;
      onProgress?.(fraction, label);
    },
    signal
  );

  if (mode === 'sweep') {
    return buckets
      .filter((bucket) => bucket.simulations.length > 0)
      .map((bucket) => {
        const paramValue = parseFloat(bucket.configId.split('-')[1] || '0');
        return summarizeSmaRow(paramValue, bucket.simulations, monthlyCpi);
      });
  }

  if (mode === 'variant-summaries') {
    return configs.map((config, index) => ({
      label: labels ? labels[index] : config.id,
      summary: summarizeSmaRow(0, buckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [], monthlyCpi),
    }));
  }

  return configs.map((config, index) => ({
    label: labels ? labels[index] : config.id,
    simulations: buckets.find((bucket) => bucket.configId === config.id)?.simulations ?? [],
  }));
}

export async function runParallelVariants({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  variants,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  variants: Array<{ label: string; config: EtfConfig }>;
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  onProgress?: (completed: number, total: number) => void;
}): Promise<Array<{ label: string; simulations: RollingSimulationPoint[] }>> {
  const configs = variants.map((v: { label: string; config: EtfConfig }) => v.config);
  const labels = variants.map((v: { label: string; config: EtfConfig }) => v.label);
  return runParallelSimulations({
    prices,
    rates,
    windowLength,
    startDate,
    endDate,
    historyWrap,
    configs,
    labels,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    mode: 'variants',
  }) as Promise<Array<{ label: string; simulations: RollingSimulationPoint[] }>>;
}

export async function runParallelVariantSummaries({
  prices,
  rates,
  windowLength,
  startDate,
  endDate,
  historyWrap = CONSTANT_HISTORY_WRAP_ENABLED,
  variants,
  riskOffValuesByAsset,
  riskOffOpenValuesByAsset,
  monthlyCpi,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  windowLength: number;
  startDate: string;
  endDate: string;
  historyWrap?: boolean;
  variants: Array<{ label: string; config: EtfConfig }>;
  riskOffValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  riskOffOpenValuesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  monthlyCpi?: Array<{ date: string; value: number }>;
}): Promise<VariantSummaryResult[]> {
  const configs = variants.map((v: { label: string; config: EtfConfig }) => v.config);
  const labels = variants.map((v: { label: string; config: EtfConfig }) => v.label);
  return runParallelSimulations({
    prices,
    rates,
    windowLength,
    startDate,
    endDate,
    historyWrap,
    configs,
    labels,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    monthlyCpi,
    mode: 'variant-summaries',
  }) as Promise<VariantSummaryResult[]>;
}

/**
 * Run a backtest using the shared `simulateWithWarmUp` code path so that
 * SMA state matches the rolling simulation exactly.
 *
 * Configs with different `smaIndex` values (e.g. sp500 vs nasdaq100) are
 * grouped and simulated separately with the correct index prices, then
 * merged into a single BacktestResult.
 */
export async function runParallelBacktest({
  prices,
  rates,
  startDate,
  endDate,
  configs,
  riskOffPricesByAsset,
  etfPricePointsByName,
  pricesByIndex,
  onProgress,
}: {
  prices: PricePoint[];
  rates: RatePoint[];
  startDate: string;
  endDate: string;
  configs: EtfConfig[];
  riskOffPricesByAsset?: Partial<Record<EtfConfig["riskOffAsset"], PricePoint[]>>;
  etfPricePointsByName?: Record<string, PricePoint[]>;
  pricesByIndex?: Record<string, PricePoint[]>;
  onProgress?: (completedUnits: number, totalUnits: number, label?: string) => void;
}): Promise<BacktestResult> {
  // Group configs by smaIndex so each group runs against its correct index prices
  const groups = new Map<string, EtfConfig[]>();
  for (const config of configs) {
    const key = config.smaIndex;
    const group = groups.get(key);
    if (group) {
      group.push(config);
    } else {
      groups.set(key, [config]);
    }
  }

  // Run each index group through simulateWithWarmUp and collect etfResults.
  // Use all available data before startDate as warm-up so SMA state matches
  // the precomputed sweep path (which simulates from day 0).
  const allEtfResults: EtfResult[] = [];
  let resultDates: string[] = [];
  const groupEntries = Array.from(groups.entries());
  const totalUnits = groupEntries.reduce((sum, [smaIndex, groupConfigs]) => {
    const groupPrices = pricesByIndex?.[smaIndex] ?? prices;
    const expandedCount = groupConfigs.reduce((count, config) => count + (config.smaEnabled ? 2 : 1), 0);
    return sum + Math.max(1, groupPrices.length - 1) * expandedCount;
  }, 0);
  let completedUnits = 0;

  const trimEtfResultToStartDate = (etfResult: EtfResult, seriesStartDate: string, config: EtfConfig): EtfResult => {
    const rawStartIdx = etfResult.dates.findIndex((date) => date >= seriesStartDate);
    const startIdx = rawStartIdx < 0 ? 0 : rawStartIdx;

    const dates = startIdx > 0 ? etfResult.dates.slice(startIdx) : etfResult.dates;
    const slicedDailyValues = startIdx > 0 ? etfResult.dailyValues.slice(startIdx) : etfResult.dailyValues;
    const slicedSmaPrices = startIdx > 0 ? etfResult.smaPrices.slice(startIdx) : etfResult.smaPrices;
    const slicedSmaSignals = startIdx > 0
      ? etfResult.smaSignals.filter((signal) => signal.date >= dates[0])
      : etfResult.smaSignals;

    const firstDate = dates[0];
    const lastDate = dates[dates.length - 1];
    const hasSma = etfResult.smaSignals.length > 0;
    const lastSignalAtOrBefore = (cutoff: string) => {
      let latest: typeof etfResult.smaSignals[number] | undefined;
      for (const s of etfResult.smaSignals) {
        if (s.date <= cutoff) latest = s;
        else break;
      }
      return latest;
    };
    const startSignal = hasSma ? lastSignalAtOrBefore(firstDate) : undefined;
    const endSignal = hasSma ? lastSignalAtOrBefore(lastDate) : undefined;
    const startInRiskOff = startSignal?.type === "sell";
    const endInRiskOff = endSignal?.type === "sell";
    const entrySpread = startInRiskOff
      ? getRiskOffSpread(config.riskOffAsset, false)
      : getSymbolSpread(config.name, false);
    const exitSpread = endInRiskOff
      ? getRiskOffSpread(config.riskOffAsset, false)
      : getSymbolSpread(config.name, false);
    const perTransitionSpread = config.smaEnabled
      ? getTransitionSpreadCost(config.name, config.riskOffAsset, false)
      : 0;

    // Regime on the trimmed window's first day: the last signal before it wins;
    // with none, the incoming window's start state carries through.
    let smaStartInvested = etfResult.smaStartInvested;
    if (smaStartInvested !== undefined) {
      for (const s of etfResult.smaSignals) {
        if (s.date >= firstDate) break;
        smaStartInvested = s.type === "buy";
      }
    }

    if (dates.length < 2 || slicedDailyValues.length < 2) {
      const fallbackFinal = slicedDailyValues[slicedDailyValues.length - 1] ?? 0;
      return {
        ...etfResult,
        dates,
        dailyValues: slicedDailyValues,
        finalValue: fallbackFinal,
        cagr: 0,
        sharpeRatio: 0,
        maxDrawdownPct: 0,
        maxDrawdownDollar: 0,
        longestDrawdownDays: 0,
        bestMonth: 0,
        worstMonth: 0,
        smaPrices: slicedSmaPrices,
        smaSignals: slicedSmaSignals,
        smaStartInvested,
        totalTradingCostPct: 0,
      };
    }

    const baseValue = slicedDailyValues[0];
    const factor = !Number.isFinite(baseValue) || baseValue <= 0 ? 1 : CONSTANT_INITIAL_INVESTMENT / baseValue;
    // When the display window starts after the simulation start, treat the window start
    // as a fresh "buy" that pays the entry spread (same as simulateSingleEtf).
    const dailyValuesPreEntry = startIdx > 0 ? slicedDailyValues.map((value) => value * factor) : slicedDailyValues;
    const dailyValues = startIdx > 0
      ? dailyValuesPreEntry.map((value) => value * (1 - entrySpread))
      : dailyValuesPreEntry;

    const rawFinalValue = dailyValues[dailyValues.length - 1] ?? 0;
    const exitDollarCost = rawFinalValue * exitSpread;
    const finalValue = Math.max(0, rawFinalValue - exitDollarCost);

    let inWindowCost = 0;
    if (perTransitionSpread > 0 && slicedSmaSignals.length > 0) {
      const dateToIdx = new Map<string, number>();
      for (let i = 0; i < dates.length; i++) dateToIdx.set(dates[i], i);
      for (const signal of slicedSmaSignals) {
        const idx = dateToIdx.get(signal.date);
        if (idx === undefined) continue;
        inWindowCost += dailyValues[idx] * perTransitionSpread;
      }
    }

    const entryCost = CONSTANT_INITIAL_INVESTMENT * entrySpread;
    const totalCost = entryCost + inWindowCost + exitDollarCost;
    const totalTradingCostPct = finalValue > 0 ? (totalCost / finalValue) * 100 : 0;

    const drawdown = calcMaxDrawdownInRange(dailyValues, dates, 0, dailyValues.length - 1);
    const monthlyExtremes = calcMonthlyExtremes(dailyValues, dates);
    const sharpeRatio = calcSharpeRatio(dailyValues);
    const cagr = calcCagr(CONSTANT_INITIAL_INVESTMENT, finalValue, dates[0], dates[dates.length - 1]);

    return {
      ...etfResult,
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
      smaPrices: slicedSmaPrices,
      smaSignals: slicedSmaSignals,
      smaStartInvested,
      totalTradingCostPct,
    };
  };

  for (const [smaIndex, groupConfigs] of groupEntries) {
    const groupPrices = pricesByIndex?.[smaIndex] ?? prices;
    const expandedCount = groupConfigs.reduce((count, config) => count + (config.smaEnabled ? 2 : 1), 0);
    const groupTotalUnits = Math.max(1, groupPrices.length - 1) * expandedCount;
    const alignedRiskOffValuesByAsset = riskOffPricesByAsset
      ? Object.fromEntries(
          Object.entries(riskOffPricesByAsset)
            .filter(([, values]) => values != null && values.length > 0)
            .map(([asset, values]) => [asset, alignCloseSeriesToDates(groupPrices, values!)])
        ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
      : undefined;
    const alignedRiskOffOpenValuesByAsset = riskOffPricesByAsset
      ? Object.fromEntries(
          Object.entries(riskOffPricesByAsset)
            .filter(([, values]) => values != null && values.length > 0)
            .map(([asset, values]) => [asset, alignOpenSeriesToDates(groupPrices, values!)])
        ) as Partial<Record<EtfConfig["riskOffAsset"], number[]>>
      : undefined;
    const alignedEtfPricesByName = etfPricePointsByName
      ? Object.fromEntries(
          Object.entries(etfPricePointsByName)
            .filter(([, values]) => values != null && values.length > 0)
            .map(([name, values]) => [name, alignActualCloseSeriesToDates(groupPrices, values!)])
        )
      : undefined;
    const alignedEtfOpenPricesByName = etfPricePointsByName
      ? Object.fromEntries(
          Object.entries(etfPricePointsByName)
            .filter(([, values]) => values != null && values.length > 0)
            .map(([name, values]) => [name, alignActualOpenSeriesToDates(groupPrices, values!)])
        )
      : undefined;
    // Use all available history as warm-up (simulateWithWarmUp caps at displayIdx)
    const fullWarmUp = groupPrices.length;
    const result = simulateWithWarmUp(
      groupPrices,
      rates,
      groupConfigs,
      startDate,
      fullWarmUp,
      {
        riskOffValuesByAsset: alignedRiskOffValuesByAsset,
        riskOffOpenValuesByAsset: alignedRiskOffOpenValuesByAsset,
        etfPricesByName: alignedEtfPricesByName,
        etfOpenPricesByName: alignedEtfOpenPricesByName,
        endDate,
        onProgress: (groupCompletedUnits) => {
          onProgress?.(
            Math.min(totalUnits, completedUnits + groupCompletedUnits),
            totalUnits,
            `Running ${smaIndex === "nasdaq100" ? LABEL_INDEX_NASDAQ100_TR : LABEL_INDEX_SP500_TR} simulations...`
          );
        },
      },
    );
    const normalizedEtfResults = result.etfResults.map((etfResult) => {
      const groupConfig = groupConfigs.find((config) => config.id === etfResult.id || etfResult.id.startsWith(`${config.id}-`));
      if (!groupConfig) return etfResult;
      const seriesStartDate = groupConfig.displayStartDate ?? getConfigDefaultStartDate(groupConfig);
      const effectiveSeriesStartDate = seriesStartDate > startDate ? seriesStartDate : startDate;
      return trimEtfResultToStartDate(etfResult, effectiveSeriesStartDate, groupConfig);
    });
    allEtfResults.push(...normalizedEtfResults);
    completedUnits += groupTotalUnits;
    onProgress?.(
      Math.min(totalUnits, completedUnits),
      totalUnits,
      `Running ${smaIndex === "nasdaq100" ? LABEL_INDEX_NASDAQ100_TR : LABEL_INDEX_SP500_TR} simulations...`,
    );
  }

  // Compute nonLeveragedValues from the base prices for the display window
  const startIdx = prices.findIndex(p => p.date >= startDate);
  let endIdx = prices.length - 1;
  if (endDate) {
    while (endIdx > startIdx && prices[endIdx].date > endDate) endIdx--;
  }
  const nonLeveragedValues = prices.slice(startIdx, endIdx + 1).map(p => p.adj_close);

  resultDates = prices.slice(startIdx, endIdx + 1).map(p => p.date);

  return {
    dates: resultDates,
    nonLeveragedValues,
    investedValues: new Array(nonLeveragedValues.length).fill(CONSTANT_INITIAL_INVESTMENT),
    etfResults: allEtfResults,
  };
}

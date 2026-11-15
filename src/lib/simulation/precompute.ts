// Full-history daily values for every config of a parallel run, simulated once
// on the main thread. Rolling windows are then sliced from these series
// (`window-extraction.ts`, `wrapped-window.ts`) without re-simulating.

import type { EtfConfig, PricePoint, RatePoint, SmaSignal } from "./types";
import { buildRateLookup } from "./borrowing-rate";
import { simulateSingleEtf } from "./single-etf";
import { computeSimulatedRiskOnReturn } from "./swap-spread";
import { computeNonLeveraged, extractDerivedArrays, type DerivedArrays } from "./derived-arrays";
import { getRiskOffSpread, getSymbolSpread, getTransitionSpreadCostForConfig } from "../constants";
import { DEFAULT_SMA_EXECUTION_MODE } from "../input-normalization";
import { buildRiskOffDayPrefix } from "./window-calculations";
import type { WindowSource } from "./window-extraction";
import { throwIfAborted } from "../abort";
import { yieldToBrowser } from "../yield-to-browser";

type SeriesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

/**
 * Pre-computed daily values for a single config across the FULL date range.
 */
export interface PrecomputedConfigDailyValues extends WindowSource {
  configId: string;
  indexKey: EtfConfig["smaIndex"];
  smaSignals?: SmaSignal[];
  smaPrices?: number[];
  perTransitionSpreadPct?: number;
  /** Set of date-array indices where a trade (SMA signal) occurs. Not structured-clone friendly. */
  tradeDayIndexSet?: Set<number>;
  /** Prefix sum of transition spread fractions. Length = n + 1. */
  tradeSpreadPrefix?: Float64Array;
  /** Half-spread for risk-on asset (fraction) */
  riskOnSpread?: number;
  /** Half-spread for risk-off asset (fraction) */
  riskOffSpread?: number;
}

/** Inputs shared by every config of one precompute pass. */
export interface PrecomputeInputs {
  prices: PricePoint[];
  rates: RatePoint[];
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
  etfPricesByName?: Record<string, number[]>;
  etfOpenPricesByName?: Record<string, number[]>;
  /** Per-index price series; a config without an entry runs on `prices`. */
  pricesByIndex?: Record<string, PricePoint[]>;
}

type PrecomputeProgress = (completedUnits: number, totalUnits: number, label?: string) => void;

interface IndexSimulationContext extends DerivedArrays {
  timestamps: number[];
  borrowingRates: number[];
  nonLeveragedValues: number[];
}

// Keyed on both inputs: borrowing rates are part of the context, so a second
// run on the same prices with a different rate series must not reuse it.
const indexContextCache = new WeakMap<PricePoint[], WeakMap<RatePoint[], IndexSimulationContext>>();

function getIndexSimulationContext(
  prices: PricePoint[],
  rates: RatePoint[],
  rateLookup: { getRate(date: string): number }
): IndexSimulationContext {
  const byRates = indexContextCache.get(prices);
  const cached = byRates?.get(rates);
  if (cached) return cached;

  const derived = extractDerivedArrays(prices);
  const context: IndexSimulationContext = {
    ...derived,
    timestamps: derived.dates.map((date) => new Date(`${date}T00:00:00Z`).getTime()),
    borrowingRates: derived.dates.map((date) => rateLookup.getRate(date)),
    nonLeveragedValues: computeNonLeveraged(derived.indexValues),
  };
  if (byRates) byRates.set(rates, context);
  else indexContextCache.set(prices, new WeakMap([[rates, context]]));
  return context;
}

function buildTradePrefixes(
  dates: string[],
  dailyValues: number[],
  perTransitionSpreadFraction: number,
  signals?: SmaSignal[]
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

function buildRiskOffStateByIndex(dates: string[], signals?: SmaSignal[]): Int8Array | undefined {
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

/**
 * Leveraged risk-on daily returns for one index context. In a sweep, all
 * configs share leverage/ER/index, so this array is computed once and reused
 * across all configs — saving ~53 redundant computeSimulatedRiskOnReturn
 * calls per day per sweep.
 */
function buildPrecomputedRiskOnReturns(context: IndexSimulationContext, config: EtfConfig): number[] {
  const erDaily = config.expenseRatio / 100 / 252;
  const returns = new Array<number>(context.indexReturns.length);
  returns[0] = 0;
  for (let i = 1; i < context.indexReturns.length; i++) {
    returns[i] = computeSimulatedRiskOnReturn(
      context.indexReturns[i],
      context.borrowingRates[i],
      config.smaIndex,
      config.leverage,
      erDaily
    );
  }
  return returns;
}

/** Spreads a config pays: at its execution hours for switches, regular hours at the window edges. */
function configSpreads(config: EtfConfig) {
  const afterHours = (config.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE) === "trigger-day-close";
  const perTransitionSpreadFraction = config.smaEnabled
    ? getTransitionSpreadCostForConfig(config, afterHours)
    : 0;
  return {
    perTransitionSpreadFraction,
    perTransitionSpreadPct: perTransitionSpreadFraction * 100,
    riskOnSpread: getSymbolSpread(config.name, afterHours),
    riskOffSpread: getRiskOffSpread(config.riskOffAsset, afterHours),
    riskOnSpreadRegular: getSymbolSpread(config.name, false),
    riskOffSpreadRegular: getRiskOffSpread(config.riskOffAsset, false),
  };
}

/** Structured-clone-friendly copy of a signal (only the fields window code reads). */
function cloneSignal(s: SmaSignal): SmaSignal {
  return {
    date: s.date,
    type: s.type,
    price: s.price,
    ...(s.trigger ? { trigger: s.trigger } : {}),
  };
}

/**
 * Simulates configs one at a time against shared inputs, reusing each index's
 * context and each (index, leverage, ER) risk-on return series across configs.
 */
function createPrecomputer(inputs: PrecomputeInputs, configs: EtfConfig[]) {
  const rateLookup = buildRateLookup(inputs.rates);
  const riskOnReturnsByKey = new Map<string, number[]>();
  const pricesFor = (config: EtfConfig) => inputs.pricesByIndex?.[config.smaIndex] ?? inputs.prices;
  const stepsFor = (config: EtfConfig) => Math.max(1, pricesFor(config).length - 1);
  const totalUnits = configs.reduce((sum, config) => sum + stepsFor(config), 0);
  let completedUnits = 0;

  function riskOnReturnsFor(config: EtfConfig, context: IndexSimulationContext): number[] | undefined {
    if (!config.simulated) return undefined;
    const key = `${config.smaIndex}|${config.leverage}|${config.expenseRatio}`;
    let returns = riskOnReturnsByKey.get(key);
    if (!returns) {
      returns = buildPrecomputedRiskOnReturns(context, config);
      riskOnReturnsByKey.set(key, returns);
    }
    return returns;
  }

  function precompute(config: EtfConfig, label: string, onProgress?: PrecomputeProgress): PrecomputedConfigDailyValues {
    const context = getIndexSimulationContext(pricesFor(config), inputs.rates, rateLookup);
    const result = simulateSingleEtf(
      config,
      context.dates,
      context.indexValues,
      context.indexReturns,
      context.openPrices,
      context.closePrices,
      context.borrowingRates,
      inputs.riskOffValuesByAsset,
      inputs.riskOffOpenValuesByAsset,
      inputs.etfPricesByName,
      inputs.etfOpenPricesByName,
      (completedSteps, totalSteps) => {
        onProgress?.(completedUnits + Math.min(completedSteps, totalSteps), totalUnits, label);
      },
      { skipMetrics: true, precomputedRiskOnReturns: riskOnReturnsFor(config, context) }
    );
    completedUnits += Math.max(1, context.dates.length - 1);
    onProgress?.(completedUnits, totalUnits, label);

    const spreads = configSpreads(config);
    const riskOffStateByIndex = buildRiskOffStateByIndex(context.dates, result.smaSignals);
    return {
      configId: config.id,
      indexKey: config.smaIndex,
      dailyValues: result.dailyValues,
      smaSignals: result.smaSignals?.map(cloneSignal),
      smaPrices: result.smaPrices,
      timestamps: context.timestamps,
      riskOffStateByIndex,
      riskOffDayPrefix: buildRiskOffDayPrefix(riskOffStateByIndex, context.dates.length),
      nonLeveragedValues: context.nonLeveragedValues,
      ...spreads,
      ...buildTradePrefixes(context.dates, result.dailyValues, spreads.perTransitionSpreadFraction, result.smaSignals),
    };
  }

  return { precompute };
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
  riskOffValuesByAsset?: SeriesByAsset,
  riskOffOpenValuesByAsset?: SeriesByAsset,
  etfPricesByName?: Record<string, number[]>,
  etfOpenPricesByName?: Record<string, number[]>,
  pricesByIndex?: Record<string, PricePoint[]>,
  onProgress?: PrecomputeProgress
): PrecomputedConfigDailyValues[] {
  const { precompute } = createPrecomputer(
    { prices, rates, riskOffValuesByAsset, riskOffOpenValuesByAsset, etfPricesByName, etfOpenPricesByName, pricesByIndex },
    configs
  );
  return configs.map((config) => precompute(config, "Running simulations...", onProgress));
}

/** Configs simulated between yields to the browser's event loop. */
const CONFIGS_PER_YIELD = 2;

/**
 * {@link precomputeAllConfigDailyValues} for the browser: checks `signal`
 * between configs and yields to the event loop so the page stays responsive.
 */
export async function precomputeAllConfigDailyValuesAsync(
  inputs: PrecomputeInputs,
  configs: EtfConfig[],
  onProgress?: PrecomputeProgress,
  signal?: AbortSignal
): Promise<PrecomputedConfigDailyValues[]> {
  const { precompute } = createPrecomputer(inputs, configs);
  const results: PrecomputedConfigDailyValues[] = [];
  for (let configIndex = 0; configIndex < configs.length; configIndex += 1) {
    throwIfAborted(signal);
    results.push(precompute(configs[configIndex], `Running simulations (${configIndex + 1}/${configs.length})...`, onProgress));
    if (configIndex < configs.length - 1 && configIndex % CONFIGS_PER_YIELD === CONFIGS_PER_YIELD - 1) {
      await yieldToBrowser();
    }
  }
  return results;
}

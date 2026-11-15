import type {
  PricePoint,
  RatePoint,
  EtfConfig,
  BacktestResult,
} from "./types";
import { buildRateLookup } from "./borrowing-rate";
import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import { renormalizeSeriesFromIndex } from "./window-calculations";
import { computeNonLeveraged, extractDerivedArrays } from "./derived-arrays";
import {
  compareEtfResultOrder,
  dedupeExpandedConfigs,
  expandEtfConfigs,
  findOwningConfig,
} from "./etf-config-expansion";
import { simulateSingleEtf } from "./single-etf";
import { trimEtfResultToStartDate } from "./trim-etf-result";

type SeriesByAsset = Partial<Record<EtfConfig["riskOffAsset"], number[]>>;

export interface SimulateBacktestOptions {
  riskOffValuesByAsset?: SeriesByAsset;
  riskOffOpenValuesByAsset?: SeriesByAsset;
  etfPricesByName?: Record<string, number[]>;
  etfOpenPricesByName?: Record<string, number[]>;
  onProgress?: (completedUnits: number, totalUnits: number) => void;
}

/**
 * Run a full backtest simulation: every config (expanded into its no-SMA and
 * SMA variants, deduped) over the whole price range, plus the 1x index path.
 * See `simulateSingleEtf` for the daily LETF formula.
 */
export function simulateBacktest(
  prices: PricePoint[],
  rates: RatePoint[],
  etfConfigs: EtfConfig[],
  options?: SimulateBacktestOptions
): BacktestResult {
  if (prices.length < 2) {
    return { dates: [], nonLeveragedValues: [], investedValues: [], etfResults: [] };
  }

  const rateLookup = buildRateLookup(rates);
  const { dates, indexValues, openPrices, closePrices, indexReturns } = extractDerivedArrays(prices);

  // Pre-compute daily borrowing rates for O(1) lookup during simulation
  const dailyBorrowingRates = prices.map((price) => rateLookup.getRate(price.date));

  const { unique: uniqueExpandedConfigs, aliases: etfResultIdAliases } =
    dedupeExpandedConfigs(expandEtfConfigs(etfConfigs));
  const stepsPerConfig = Math.max(1, dates.length - 1);
  const totalUnits = uniqueExpandedConfigs.length * stepsPerConfig;

  const etfResults = uniqueExpandedConfigs
    .map((config, configIndex) => {
      const completedBefore = configIndex * stepsPerConfig;
      const result = simulateSingleEtf(
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
          options?.onProgress?.(completedBefore + Math.min(completedSteps, totalSteps), totalUnits);
        }
      );
      options?.onProgress?.(completedBefore + stepsPerConfig, totalUnits);
      return result;
    })
    .sort(compareEtfResultOrder);

  return {
    dates,
    nonLeveragedValues: computeNonLeveraged(indexValues),
    investedValues: new Array(dates.length).fill(CONSTANT_INITIAL_INVESTMENT),
    etfResults,
    etfResultIdAliases,
  };
}

/**
 * Drop the first `displayStartIdx` (warm-up) days from a backtest, re-entering
 * every result at the display window's first close through
 * `trimEtfResultToStartDate` — the same trim `runParallelBacktest` applies per
 * config, so warm-up and display-date trims cannot disagree on spreads or costs.
 */
function sliceBacktestResultToWindow(
  result: BacktestResult,
  displayStartIdx: number,
  configs: EtfConfig[],
): BacktestResult {
  if (displayStartIdx <= 0) return result;

  const dates = result.dates.slice(displayStartIdx);
  if (dates.length < 2) return result;

  const etfResults = result.etfResults.map((etf) => {
    const config = findOwningConfig(configs, etf.id);
    if (!config) throw new Error(`No requested config owns simulated result "${etf.id}"`);
    return trimEtfResultToStartDate(etf, dates[0], config);
  });

  return {
    dates,
    nonLeveragedValues: renormalizeSeriesFromIndex(result.nonLeveragedValues, displayStartIdx),
    investedValues: result.investedValues.slice(displayStartIdx),
    etfResults,
    // Slicing preserves ids, so the alias map survives the window trim.
    etfResultIdAliases: result.etfResultIdAliases,
  };
}

/** Each series in `record` from index `fromIdx` on; null/undefined entries are dropped. */
function sliceSeriesRecord<R extends Partial<Record<string, number[]>>>(
  record: R | undefined,
  fromIdx: number
): R | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, number[]] => entry[1] != null)
      .map(([key, values]) => [key, values.slice(fromIdx)])
  ) as R;
}

/**
 * Rates covering [startDate, endDate], plus the last rate before startDate:
 * getRate carries the most recent prior rate forward, so a series that is
 * monthly (tbill-1m, treasury-2y) or simply has no row on startDate would
 * otherwise throw.
 */
function ratesForRange(rates: RatePoint[], startDate: string, endDate: string): RatePoint[] {
  const inWindowRates = rates.filter((r) => r.date >= startDate && r.date <= endDate);
  const carriedInRate = rates.reduce<RatePoint | undefined>(
    (latest, r) =>
      r.date < startDate && (latest === undefined || r.date > latest.date) ? r : latest,
    undefined
  );
  return carriedInRate ? [carriedInRate, ...inWindowRates] : inWindowRates;
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
  options?: SimulateBacktestOptions & { endDate?: string },
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
  const simRates = ratesForRange(rates, simPrices[0].date, simPrices[simPrices.length - 1].date);

  const result = simulateBacktest(simPrices, simRates, configs, {
    riskOffValuesByAsset: sliceSeriesRecord(options?.riskOffValuesByAsset, simStartIdx),
    riskOffOpenValuesByAsset: sliceSeriesRecord(options?.riskOffOpenValuesByAsset, simStartIdx),
    etfPricesByName: sliceSeriesRecord(options?.etfPricesByName, simStartIdx),
    etfOpenPricesByName: sliceSeriesRecord(options?.etfOpenPricesByName, simStartIdx),
    onProgress: options?.onProgress,
  });

  return sliceBacktestResultToWindow(result, warmUpOffset, configs);
}

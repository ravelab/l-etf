// A single backtest over configs that may span both indices (the backtest and
// futures pages, MCP `compare_backtests`). Each index group runs through the
// same `simulateWithWarmUp` path as the rolling simulation, so SMA state
// matches it exactly, then every result is trimmed to its own start date.

import type { BacktestResult, EtfConfig, EtfResult, PricePoint, RatePoint } from "./types";
import { simulateWithWarmUp } from "./engine";
import { expandedConfigCount, findOwningConfig } from "./etf-config-expansion";
import { trimEtfResultToStartDate } from "./trim-etf-result";
import { latestCommonCloseDate } from "./common-close-date";
import { getConfigDefaultStartDate } from "./presets";
import {
  CONSTANT_INITIAL_INVESTMENT,
  LABEL_INDEX_NASDAQ100_TR,
  LABEL_INDEX_SP500_TR,
} from "../constants";
import { alignCloseSeriesToDates, alignOpenSeriesToDates } from "../utils";

type SeriesAligner = (basePrices: PricePoint[], points: PricePoint[]) => number[];

/**
 * A real ETF's prices on the base series' dates, carrying the last known price
 * forward and NaN before the first. Unlike the risk-off aligners, a real ETF is
 * never interpolated: before launch the engine falls back to simulated returns.
 */
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

const alignActualCloseSeriesToDates: SeriesAligner = (basePrices, points) =>
  alignActualSeriesToDates(basePrices, points, (point) => point.adj_close);

const alignActualOpenSeriesToDates: SeriesAligner = (basePrices, points) =>
  alignActualSeriesToDates(basePrices, points, (point) => point.adj_open ?? point.adj_close);

/** Every non-empty series in `record`, aligned onto `basePrices`' dates. */
function alignSeriesRecord<K extends string>(
  record: Partial<Record<K, PricePoint[]>> | undefined,
  basePrices: PricePoint[],
  align: SeriesAligner
): Record<K, number[]> | undefined {
  if (!record) return undefined;
  const entries = Object.entries(record) as Array<[K, PricePoint[] | undefined]>;
  return Object.fromEntries(
    entries
      .filter((entry): entry is [K, PricePoint[]] => entry[1] != null && entry[1].length > 0)
      .map(([key, points]) => [key, align(basePrices, points)])
  ) as Record<K, number[]>;
}

interface BacktestInputs {
  prices: PricePoint[];
  endDate: string;
  pricesByIndex?: Record<string, PricePoint[]>;
}

/**
 * Real overlays must end on the same observed close as their simulated twins.
 * Carrying the ETF's previous close into a fresh index day fabricates a 0% return.
 */
function capToCommonClose(
  inputs: BacktestInputs,
  configs: EtfConfig[],
  startDate: string,
  etfPricePointsByName: Record<string, PricePoint[]> | undefined
): BacktestInputs {
  const actualSeries = configs.filter((config) => !config.simulated)
    .map((config) => etfPricePointsByName?.[config.name.replace(/-real$/, "")])
    .filter((points): points is PricePoint[] => (points?.length ?? 0) > 0);
  if (actualSeries.length === 0) return inputs;

  const indexSeries = [...new Set(configs.map((config) => config.smaIndex))]
    .map((index) => inputs.pricesByIndex?.[index] ?? inputs.prices);
  const endDate = latestCommonCloseDate([...indexSeries, ...actualSeries], inputs.endDate);
  if (!endDate || endDate <= startDate) {
    throw new Error("Not enough shared closing prices for the ETF comparison.");
  }
  const upToEnd = (points: PricePoint[]) => points.filter((point) => point.date <= endDate);
  return {
    endDate,
    prices: upToEnd(inputs.prices),
    pricesByIndex: inputs.pricesByIndex
      ? Object.fromEntries(Object.entries(inputs.pricesByIndex).map(([index, points]) => [index, upToEnd(points)]))
      : undefined,
  };
}

function groupBySmaIndex(configs: EtfConfig[]): Array<[EtfConfig["smaIndex"], EtfConfig[]]> {
  const groups = new Map<EtfConfig["smaIndex"], EtfConfig[]>();
  for (const config of configs) {
    groups.set(config.smaIndex, [...(groups.get(config.smaIndex) ?? []), config]);
  }
  return Array.from(groups.entries());
}

function indexProgressLabel(smaIndex: EtfConfig["smaIndex"]): string {
  return `Running ${smaIndex === "nasdaq100" ? LABEL_INDEX_NASDAQ100_TR : LABEL_INDEX_SP500_TR} simulations...`;
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
  prices: requestedPrices,
  rates,
  startDate,
  endDate: requestedEndDate,
  configs,
  riskOffPricesByAsset,
  etfPricePointsByName,
  pricesByIndex: requestedPricesByIndex,
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
  const { prices, endDate, pricesByIndex } = capToCommonClose(
    { prices: requestedPrices, endDate: requestedEndDate, pricesByIndex: requestedPricesByIndex },
    configs,
    startDate,
    etfPricePointsByName
  );
  const groups = groupBySmaIndex(configs);
  const pricesFor = (smaIndex: EtfConfig["smaIndex"]) => pricesByIndex?.[smaIndex] ?? prices;
  const unitsFor = (smaIndex: EtfConfig["smaIndex"], groupConfigs: EtfConfig[]) =>
    Math.max(1, pricesFor(smaIndex).length - 1) * expandedConfigCount(groupConfigs);
  const totalUnits = groups.reduce((sum, [smaIndex, groupConfigs]) => sum + unitsFor(smaIndex, groupConfigs), 0);
  let completedUnits = 0;

  // Run each index group through simulateWithWarmUp and collect etfResults.
  // Use all available data before startDate as warm-up so SMA state matches
  // the precomputed sweep path (which simulates from day 0).
  const allEtfResults: EtfResult[] = [];
  // Each per-index group dedupes independently; ids are unique across groups, so
  // their alias maps merge without collision.
  const allEtfResultIdAliases: Record<string, string> = {};

  for (const [smaIndex, groupConfigs] of groups) {
    const groupPrices = pricesFor(smaIndex);
    const label = indexProgressLabel(smaIndex);
    const result = simulateWithWarmUp(
      groupPrices,
      rates,
      groupConfigs,
      startDate,
      // All available history as warm-up (simulateWithWarmUp caps at displayIdx)
      groupPrices.length,
      {
        riskOffValuesByAsset: alignSeriesRecord(riskOffPricesByAsset, groupPrices, alignCloseSeriesToDates),
        riskOffOpenValuesByAsset: alignSeriesRecord(riskOffPricesByAsset, groupPrices, alignOpenSeriesToDates),
        etfPricesByName: alignSeriesRecord(etfPricePointsByName, groupPrices, alignActualCloseSeriesToDates),
        etfOpenPricesByName: alignSeriesRecord(etfPricePointsByName, groupPrices, alignActualOpenSeriesToDates),
        endDate,
        onProgress: (groupCompletedUnits) => {
          onProgress?.(Math.min(totalUnits, completedUnits + groupCompletedUnits), totalUnits, label);
        },
      },
    );
    for (const etfResult of result.etfResults) {
      const groupConfig = findOwningConfig(groupConfigs, etfResult.id);
      if (!groupConfig) {
        allEtfResults.push(etfResult);
        continue;
      }
      const seriesStartDate = groupConfig.displayStartDate ?? getConfigDefaultStartDate(groupConfig);
      const effectiveSeriesStartDate = seriesStartDate > startDate ? seriesStartDate : startDate;
      allEtfResults.push(trimEtfResultToStartDate(etfResult, effectiveSeriesStartDate, groupConfig));
    }
    Object.assign(allEtfResultIdAliases, result.etfResultIdAliases);
    completedUnits += unitsFor(smaIndex, groupConfigs);
    onProgress?.(Math.min(totalUnits, completedUnits), totalUnits, label);
  }

  // Compute nonLeveragedValues from the base prices for the display window
  const startIdx = prices.findIndex(p => p.date >= startDate);
  let endIdx = prices.length - 1;
  if (endDate) {
    while (endIdx > startIdx && prices[endIdx].date > endDate) endIdx--;
  }
  const displayPrices = prices.slice(startIdx, endIdx + 1);
  const nonLeveragedValues = displayPrices.map(p => p.adj_close);

  return {
    dates: displayPrices.map(p => p.date),
    nonLeveragedValues,
    investedValues: new Array(nonLeveragedValues.length).fill(CONSTANT_INITIAL_INVESTMENT),
    etfResults: allEtfResults,
    etfResultIdAliases: allEtfResultIdAliases,
  };
}

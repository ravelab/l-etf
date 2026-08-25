import type { BacktestResult, EtfConfig, IndexKey, PricePoint, RatePoint } from "@/lib/simulation/types";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { getSwapSpreadDaily } from "@/lib/simulation/engine";

type UnderlyingIndexSeries = {
  index: IndexKey;
  label: string;
  dates: string[];
  values: number[];
};

function getIndexLabel(index: IndexKey): string {
  return index === "nasdaq100" ? "QQQ" : "VOO";
}

function stripVariantSuffix(id: string): string {
  if (id.endsWith("-base")) return id.slice(0, -5);
  if (id.endsWith("-sma")) return id.slice(0, -4);
  if (id.endsWith("-smaOpen")) return id.slice(0, -8);
  if (id.endsWith("-smaClose")) return id.slice(0, -9);
  return id;
}

function alignValuesToDates(
  dates: string[],
  points: PricePoint[],
  selector: (point: PricePoint) => number,
): number[] {
  const valueByDate = new Map(
    points
      .map((point) => [point.date, selector(point)] as const)
      .filter((entry) => Number.isFinite(entry[1]))
  );

  // Seed with the earliest point so dates before the series carry a sensible
  // value forward. `points` is already date-ascending (parsed straight from the
  // date-sorted CSVs), so the earliest is points[0] — sorting a ~35,000-row copy
  // to read one element ran dozens of times per chart rebuild.
  let lastKnownValue = points.length > 0 ? selector(points[0]) : 0;

  return dates.map((date) => {
    const value = valueByDate.get(date);
    if (value !== undefined) {
      lastKnownValue = value;
      return value;
    }
    return lastKnownValue;
  });
}

function alignSeriesToDates(
  targetDates: string[],
  sourceDates: string[],
  sourceValues: number[],
): number[] {
  const valueByDate = new Map<string, number>();
  for (let i = 0; i < sourceDates.length && i < sourceValues.length; i++) {
    const value = sourceValues[i];
    if (Number.isFinite(value)) valueByDate.set(sourceDates[i], value);
  }
  let lastKnown = sourceValues.find((v) => Number.isFinite(v)) ?? 0;
  return targetDates.map((date) => {
    const value = valueByDate.get(date);
    if (value !== undefined) {
      lastKnown = value;
      return value;
    }
    return lastKnown;
  });
}

export function buildBacktestChartSeries(options: {
  pricesByIndex: Record<IndexKey, PricePoint[]>;
  requiredIndexes: IndexKey[];
  primaryIndex: IndexKey;
  resolvedEtfConfigs: EtfConfig[];
  result: BacktestResult;
  initialInvestment: number;
  etfPricePointsByName?: Record<string, PricePoint[]>;
  rates?: RatePoint[];
}) {
  const closePricesByEtfId: Record<string, number[]> = {};
  const adjustedClosePricesByEtfId: Record<string, number[]> = {};
  const openPricesByEtfId: Record<string, number[]> = {};
  const tradeClosePricesByEtfId: Record<string, number[]> = {};
  const tradeOpenPricesByEtfId: Record<string, number[]> = {};
  const syntheticPriceScaleByEtfId: Record<string, number> = {};
  const datesByEtfId: Record<string, string[]> = {};
  const syntheticBaseResultById = new Map<string, BacktestResult["etfResults"][number]>();

  for (const resultEtf of options.result.etfResults) {
    if (!resultEtf.id.endsWith("-base")) continue;
    const baseId = stripVariantSuffix(resultEtf.id);
    if (!syntheticBaseResultById.has(baseId)) {
      syntheticBaseResultById.set(baseId, resultEtf);
    }
  }

  for (const etf of options.result.etfResults) {
    const cfg = options.resolvedEtfConfigs.find((candidate) => candidate.id === stripVariantSuffix(etf.id));
    if (!cfg) continue;
    const anchorSymbol = cfg.name.replace(/-real$/, "");
    const realEtfPoints = options.etfPricePointsByName?.[anchorSymbol];

    const sourcePoints = !cfg.simulated
      ? realEtfPoints
      : options.pricesByIndex[cfg.smaIndex];

    if (!sourcePoints?.length || !etf.dates.length) continue;

    const sourceClose = alignValuesToDates(
      etf.dates,
      sourcePoints,
      cfg.simulated ? ((point) => point.close) : ((point) => point.adj_close)
    );
    const sourceAdjustedClose = alignValuesToDates(
      etf.dates,
      sourcePoints,
      (point) => point.adj_close
    );
    const sourceOpen = alignValuesToDates(
      etf.dates,
      sourcePoints,
      cfg.simulated
        ? ((point) => point.open ?? point.close)
        : ((point) => point.adj_open ?? point.adj_close)
    );

    if (cfg.simulated) {
      if (realEtfPoints?.length) {
        const realCloseByDate = new Map(
          realEtfPoints
            .map((point) => [point.date, point.adj_close] as const)
            .filter(([, value]) => Number.isFinite(value))
        );
        let anchorIndex = -1;
        for (let idx = etf.dates.length - 1; idx >= 0; idx--) {
          const date = etf.dates[idx];
          const real = realCloseByDate.get(date);
          const synthetic = sourceClose[idx];
          if (Number.isFinite(real) && Number.isFinite(synthetic) && (real as number) > 0 && (synthetic as number) > 0) {
            anchorIndex = idx;
            break;
          }
        }
        const anchorDate = anchorIndex >= 0 ? etf.dates[anchorIndex] : undefined;
        const realAnchor = anchorDate ? realCloseByDate.get(anchorDate) : undefined;
        const syntheticAnchor = anchorIndex >= 0 ? sourceClose[anchorIndex] : undefined;
        if (
          anchorIndex >= 0 &&
          Number.isFinite(realAnchor) &&
          Number.isFinite(syntheticAnchor) &&
          (realAnchor as number) > 0 &&
          (syntheticAnchor as number) > 0
        ) {
          const scale = (realAnchor as number) / (syntheticAnchor as number);
          closePricesByEtfId[etf.id] = sourceClose.map((value) => value * scale);
          adjustedClosePricesByEtfId[etf.id] = sourceAdjustedClose.map((value) => value * scale);
          openPricesByEtfId[etf.id] = sourceOpen.map((value) => value * scale);
          syntheticPriceScaleByEtfId[etf.id] = scale;
        } else {
          closePricesByEtfId[etf.id] = sourceClose;
          adjustedClosePricesByEtfId[etf.id] = sourceAdjustedClose;
          openPricesByEtfId[etf.id] = sourceOpen;
          syntheticPriceScaleByEtfId[etf.id] = 1;
        }
      } else {
        closePricesByEtfId[etf.id] = sourceClose;
        adjustedClosePricesByEtfId[etf.id] = sourceAdjustedClose;
        openPricesByEtfId[etf.id] = sourceOpen;
        syntheticPriceScaleByEtfId[etf.id] = 1;
      }
    } else {
      closePricesByEtfId[etf.id] = sourceClose;
      adjustedClosePricesByEtfId[etf.id] = sourceAdjustedClose;
      openPricesByEtfId[etf.id] = sourceOpen;
      syntheticPriceScaleByEtfId[etf.id] = 1;
    }

    if (cfg.simulated) {
      let tradeScale: number | null = null;
      const baseId = stripVariantSuffix(etf.id);
      const baseSyntheticResult = syntheticBaseResultById.get(baseId);
      const syntheticTradeClose = baseSyntheticResult
        ? alignSeriesToDates(etf.dates, baseSyntheticResult.dates, baseSyntheticResult.dailyValues)
        : closePricesByEtfId[etf.id];
      if (realEtfPoints?.length) {
      const realCloseByDate = new Map(
        realEtfPoints
          .map((point) => [point.date, point.adj_close] as const)
            .filter(([, value]) => Number.isFinite(value) && (value as number) > 0)
        );
        for (let anchorIdx = etf.dates.length - 1; anchorIdx >= 0; anchorIdx--) {
          const anchorDate = etf.dates[anchorIdx];
          const realAnchor = realCloseByDate.get(anchorDate);
          const syntheticAnchor = syntheticTradeClose[anchorIdx];
          if (
            Number.isFinite(realAnchor) &&
            Number.isFinite(syntheticAnchor) &&
            (realAnchor as number) > 0 &&
            (syntheticAnchor as number) > 0
          ) {
            tradeScale = (realAnchor as number) / (syntheticAnchor as number);
            break;
          }
        }
      }
      const leverage = Number.isFinite(cfg.leverage) && cfg.leverage !== 0 ? cfg.leverage : 1;
      const erDaily = cfg.expenseRatio / 100 / 252;
      const rateLookup = options.rates?.length ? buildRateLookup(options.rates) : null;
      const impliedOpenFromClose = (closeValue: number, idx: number): number => {
        const close = sourceClose[idx];
        const open = sourceOpen[idx];
        if (
          !Number.isFinite(open) ||
          !Number.isFinite(close) ||
          (open as number) <= 0 ||
          (close as number) <= 0
        ) {
          return closeValue;
        }
        const indexReturn = (close as number) / (open as number) - 1;
        // Daily drag: ER + (|L| - 1) × (borrowRate + swapSpread)
        let dailyDrag = erDaily;
        if (rateLookup) {
          const date = etf.dates[idx];
          // Rates may not cover the snapshot's full date range (snapshots are
          // built with default params and can extend earlier than the user's
          // current selection). Treat missing rate as zero drag for those
          // points — the main ValueChart already uses result.dailyValues, so
          // this only affects the enriched chart series.
          let borrowRateDaily = 0;
          if (date) {
            try { borrowRateDaily = rateLookup.getRate(date); } catch { /* leave as 0 */ }
          }
          const swapSpreadDaily = getSwapSpreadDaily(cfg.smaIndex, borrowRateDaily, leverage);
          dailyDrag += (Math.abs(leverage) - 1) * (borrowRateDaily + swapSpreadDaily);
        }
        const leveragedFactor = 1 + leverage * indexReturn - dailyDrag;
        if (!Number.isFinite(leveragedFactor) || leveragedFactor <= 0) {
          return closeValue;
        }
        return closeValue / leveragedFactor;
      };
      if (tradeScale && Number.isFinite(tradeScale) && tradeScale > 0) {
        const scale = tradeScale;
        tradeClosePricesByEtfId[etf.id] = syntheticTradeClose.map((value) => value * scale);
        tradeOpenPricesByEtfId[etf.id] = syntheticTradeClose.map((value, idx) =>
          impliedOpenFromClose(value * scale, idx)
        );
      } else {
        tradeClosePricesByEtfId[etf.id] = syntheticTradeClose;
        tradeOpenPricesByEtfId[etf.id] = syntheticTradeClose.map((value, idx) =>
          impliedOpenFromClose(value, idx)
        );
      }
    } else {
      tradeClosePricesByEtfId[etf.id] = closePricesByEtfId[etf.id];
      tradeOpenPricesByEtfId[etf.id] = openPricesByEtfId[etf.id];
    }

    datesByEtfId[etf.id] = etf.dates;
  }

  const underlyingIndexSeries: UnderlyingIndexSeries[] = options.requiredIndexes.map((index) => {
    const points = options.pricesByIndex[index] ?? [];
    const sliced = points.filter((point) => point.date >= options.result.dates[0] && point.date <= options.result.dates[options.result.dates.length - 1]);
    const dates = sliced.map((point) => point.date);
    // "Total Return" rows must use the stitched total-return series (`adj_close`),
    // not the raw published index level (`close`).
    const missingAdjClose = sliced.find((point) => !Number.isFinite(point.adj_close ?? Number.NaN));
    if (missingAdjClose) {
      const label = getIndexLabel(index);
      throw new Error(
        `Missing total-return data (adj_close) for ${label} on ${missingAdjClose.date}. ` +
        `Cannot compute "${label} Total Return" without adj_close.`
      );
    }
    const values = sliced.map((point) => point.adj_close as number);
    const startValue = values[0] ?? 1;

    return {
      index,
      label: getIndexLabel(index),
      dates,
      values: values.map((value) => (value / startValue) * options.initialInvestment),
    };
  });

  return {
    closePricesByEtfId,
    adjustedClosePricesByEtfId,
    openPricesByEtfId,
    tradeClosePricesByEtfId,
    tradeOpenPricesByEtfId,
    syntheticPriceScaleByEtfId,
    datesByEtfId,
    underlyingIndexSeries
  };
}

"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { createValueChartOptions } from "@/lib/chart-options";
import { annualizedInflationForRange } from "@/lib/inflation";
import type { BacktestResult, IndexKey } from "@/lib/simulation/types";
import { Button } from "@/components/ui/Button";
import { formatNumber } from "@/lib/format";
import {
  getVisibleIndexBounds,
  pickLineChartIndices,
  selectSampledIndices,
  type VisibleRange,
} from "@/lib/chart-resampling";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";

const MAX_VISIBLE_POINTS = 1800;

interface ValueChartProps {
  result: BacktestResult;
  /** Annualized inflation as a decimal (e.g. 0.03 for 3%). */
  annualizedInflation: number;
  /** Monthly CPI series used to match the table's per-row real value calculation. */
  monthlyCpi?: Array<{ date: string; value: number }>;
  underlyingIndexSeries?: Array<{
    index: IndexKey;
    label: string;
    dates: string[];
    values: number[];
  }>;
}

function ValueChartImpl({
  result,
  annualizedInflation,
  monthlyCpi,
  underlyingIndexSeries,
}: ValueChartProps) {
  const [logScale, setLogScale] = useState(true);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const tradingDays = result.dates.length;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains("dark"));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const fullData = useMemo(() => {
    const labels = result.dates;
    const baseValue = result.investedValues[0] ?? result.nonLeveragedValues[0] ?? 1;
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;

    const toNominalValuePct = (value: number) => (value / baseValue) * 100;

    const inflationRateForSeries = (seriesStartDate: string, seriesEndDate: string) =>
      monthlyCpi && monthlyCpi.length >= 2
        ? annualizedInflationForRange(monthlyCpi, seriesStartDate, seriesEndDate)
        : annualizedInflation;

    const toRealValuePct = (
      value: number,
      date: string,
      seriesStartDate: string,
      seriesEndDate: string,
      seriesInitialValue: number
    ) => {
      const yearsSinceStart = (new Date(date).getTime() - new Date(seriesStartDate).getTime()) / msPerYear;
      const inflationFactor = Math.pow(1 + inflationRateForSeries(seriesStartDate, seriesEndDate), yearsSinceStart);
      const realValue = value / inflationFactor;
      const denominator = Number.isFinite(seriesInitialValue) && seriesInitialValue > 0
        ? seriesInitialValue
        : baseValue;
      return (realValue / denominator) * 100;
    };

    // Pre-build a single date → global-index map and reuse it across all series.
    // This avoids allocating one Map per series and one full-history array per
    // Map.get call when each series has tens of thousands of points.
    const globalIndexByDate = new Map<string, number>();
    for (let i = 0; i < labels.length; i++) globalIndexByDate.set(labels[i], i);

    const mapSeriesToGlobalDates = (
      seriesDates: string[],
      seriesValues: number[],
      transform: (
        value: number,
        date: string,
        seriesStartDate: string,
        seriesEndDate: string,
        seriesInitialValue: number
      ) => number,
      finalValueOverride?: number
    ): Array<number | null> => {
      const seriesStartDate = seriesDates[0];
      if (!seriesStartDate) {
        const out = new Array<number | null>(labels.length);
        out.fill(null);
        return out;
      }
      const seriesEndDate = seriesDates[seriesDates.length - 1];
      const seriesInitialValue = seriesValues[0] ?? baseValue;
      const lastIdx = seriesDates.length - 1;
      const out = new Array<number | null>(labels.length);
      out.fill(null);
      for (let idx = 0; idx < seriesDates.length; idx++) {
        const date = seriesDates[idx];
        const globalIdx = globalIndexByDate.get(date);
        if (globalIdx === undefined) continue;
        const value =
          idx === lastIdx && finalValueOverride != null ? finalValueOverride : seriesValues[idx];
        out[globalIdx] = transform(value, date, seriesStartDate, seriesEndDate, seriesInitialValue);
      }
      return out;
    };

    const getDistinctColor = (i: number) =>
      isDarkTheme
        ? `hsl(${(i * 47) % 360} 85% 55%)`
        : `hsl(${(i * 47) % 360} 78% 40%)`;
    let seriesColorIdx = 0;
    const lineWidth = isDarkTheme ? 0.6 : 1.1;

    // Only show underlying index if underlyingIndexSeries is provided and non-empty
    const underlyingDatasets =
      underlyingIndexSeries && underlyingIndexSeries.length > 0
        ? underlyingIndexSeries.map((s) => {
            const borderColor = getDistinctColor(seriesColorIdx++);
            return {
              label: shortBacktestAssetLabel(s.label),
              data: mapSeriesToGlobalDates(s.dates, s.values, toRealValuePct),
              borderColor,
              backgroundColor: "transparent",
              borderWidth: lineWidth,
              pointRadius: 0,
              pointHitRadius: 4,
              order: 2,
            };
          })
        : [];

    const datasets = [
      ...underlyingDatasets,
      {
        label: "",
        // Keep the invested baseline horizontal: it is a fixed nominal amount.
        // (Do not deflate it by inflation.) Legend entry hidden via chart options.
        data: result.investedValues.map((v) => toNominalValuePct(v)),
        borderColor: getDistinctColor(seriesColorIdx++),
        backgroundColor: "transparent",
        borderWidth: lineWidth,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHitRadius: 4,
        order: 3,
      },
      ...result.etfResults.map((etf) => {
        const rawName = etf.name || etf.id || "Unknown ETF";
        const name = shortBacktestAssetLabel(rawName);
        const isNoSma = rawName.endsWith("(No SMA)");
        const isSma = rawName.includes("(SMA");
        const isSmaClose = rawName.includes("Trigger-Day Close");
        const borderColor = getDistinctColor(seriesColorIdx++);
        return {
          label: name,
          data: mapSeriesToGlobalDates(etf.dates, etf.dailyValues, toRealValuePct, etf.finalValue),
          borderColor,
          backgroundColor: "transparent",
          borderWidth: lineWidth,
          borderDash: isNoSma
            ? ([7, 4] as number[])
            : isSmaClose
              ? ([2, 3] as number[])
              : undefined,
          pointRadius: 0,
          pointHitRadius: 4,
          order: isSma ? 0 : 1,
        };
      }),
    ];

    return { labels, datasets };
  }, [result, underlyingIndexSeries, annualizedInflation, monthlyCpi, isDarkTheme]);

  const labelTimes = useMemo(
    () =>
      (fullData.labels ?? []).map((label) => new Date(String(label)).getTime()).filter(Number.isFinite),
    [fullData.labels]
  );

  const data = useMemo(() => {
    if (labelTimes.length === 0) return fullData;
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    const indices = selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS);
    return pickLineChartIndices(fullData, indices);
  }, [fullData, labelTimes, visibleRange]);

  const resetKey = useMemo(() => {
    const first = result.dates[0] ?? "";
    const last = result.dates[result.dates.length - 1] ?? "";
    return `${first}|${last}|${result.etfResults.length}|${underlyingIndexSeries?.length ?? 0}`;
  }, [result.dates, result.etfResults.length, underlyingIndexSeries?.length]);

  const options = useMemo(
    () =>
      createValueChartOptions(logScale, {
        omitEmptyLegendLabels: true,
        emptyLineTooltipLabel: "Nominal baseline",
      }),
    [logScale]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted">
          Days: {formatNumber(tradingDays)}
        </h3>
        <div className="flex gap-1">
          <Button
            variant={logScale ? "primary" : "ghost"}
            size="sm"
            onClick={() => setLogScale(true)}
          >
            Log
          </Button>
          <Button
            variant={!logScale ? "primary" : "ghost"}
            size="sm"
            onClick={() => setLogScale(false)}
          >
            Linear
          </Button>
        </div>
      </div>
      <div className="h-[400px]">
        <ZoomableChart
          data={data}
          options={options}
          onRangeChange={setVisibleRange}
          resetKey={resetKey}
        />
      </div>
    </div>
  );
}

export const ValueChart = memo(ValueChartImpl);

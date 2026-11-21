"use client";

import type { ChartData, ChartOptions, Plugin } from "chart.js";
import { memo, useMemo, useState } from "react";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { useIsDarkTheme } from "@/lib/hooks/use-is-dark-theme";
import { createValueChartOptions, getChartThemeColors } from "@/lib/chart-options";
import { annualizedInflationForRange, buildMonthlyCpiYoY } from "@/lib/inflation";
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
const INFLATION_AXIS = "inflation";
const formatInflation = (value: number) => `${value.toFixed(1)}%`;

const INFLATION_BAND_HEIGHT = 96;
const inflationBandPlugins: Plugin<"line">[] = [{
  id: "backtest-inflation-band",
  afterLayout(chart) {
    const portfolio = chart.scales.y;
    const inflation = chart.scales[INFLATION_AXIS];
    if (!portfolio || !inflation) return;

    // Give the two vertical scales disjoint pixel ranges on the same date axis.
    portfolio.bottom = chart.chartArea.bottom - INFLATION_BAND_HEIGHT - 8;
    inflation.top = chart.chartArea.bottom - INFLATION_BAND_HEIGHT;
    portfolio.configure();
    inflation.configure();
  },
  beforeDatasetsDraw(chart) {
    const inflation = chart.scales[INFLATION_AXIS];
    const isVisible = chart.data.datasets.some((dataset, index) =>
      dataset.yAxisID === INFLATION_AXIS && chart.isDatasetVisible(index)
    );
    if (!inflation || !isVisible) return;

    const zero = inflation.getPixelForValue(0);
    const { left, right } = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = getChartThemeColors().emphasisGrid;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(left, zero);
    ctx.lineTo(right, zero);
    ctx.stroke();
    ctx.restore();
  },
}];

interface ValueChartProps {
  result: BacktestResult;
  /** Annualized inflation as a decimal (e.g. 0.03 for 3%). */
  annualizedInflation: number;
  /** Monthly CPI series used to match the table's per-row real value calculation. */
  showInflation?: boolean;
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
  showInflation = false,
  underlyingIndexSeries,
}: ValueChartProps) {
  const [logScale, setLogScale] = useState(true);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const isDarkTheme = useIsDarkTheme();
  const tradingDays = result.dates.length;

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

    const datasets: ChartData<"line">["datasets"] = [
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

    if (showInflation && monthlyCpi) {
      const inflationByMonth = buildMonthlyCpiYoY(monthlyCpi);
      const inflation = labels.map(date => inflationByMonth.get(date.slice(0, 7)) ?? null);
      if (inflation.some(value => value !== null)) {
        datasets.push({
          label: "Inflation (YoY)",
          data: inflation,
          yAxisID: INFLATION_AXIS,
          borderColor: isDarkTheme ? "#c4b5fd" : "#6d28d9",
          borderWidth: 0.8,
          borderDash: [5, 3],
          pointRadius: 0,
          order: 4,
        });
      }
    }

    return { labels, datasets };
  }, [result, underlyingIndexSeries, annualizedInflation, monthlyCpi, isDarkTheme, showInflation]);

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

  const hasInflation = fullData.datasets.some(dataset => dataset.yAxisID === INFLATION_AXIS);
  const options = useMemo<ChartOptions<"line">>(() => {
    const base = createValueChartOptions(logScale, {
      omitEmptyLegendLabels: true,
      emptyLineTooltipLabel: "Nominal baseline",
    });
    if (!hasInflation) return base;

    const colors = getChartThemeColors(isDarkTheme);
    const tooltip = base.plugins?.tooltip;
    return {
      ...base,
      scales: {
        ...base.scales,
        y: { ...base.scales?.y, suggestedMin: 5 },
        [INFLATION_AXIS]: {
          type: "linear",
          position: "right",
          bounds: "data",
          afterDataLimits(scale) {
            scale.min = Math.min(0, scale.min);
            scale.max = Math.max(0, scale.max);
            const padding = (scale.max - scale.min) * 0.05;
            scale.min -= padding;
            scale.max += padding;
          },
          grid: { drawOnChartArea: false },
          ticks: { color: colors.tickText, maxTicksLimit: 4, callback: value => formatInflation(Number(value)) },
        },
      },
      plugins: {
        ...base.plugins,
        tooltip: {
          ...tooltip,
          callbacks: {
            ...tooltip?.callbacks,
            label(item) {
              if (item.dataset.yAxisID !== INFLATION_AXIS) return tooltip?.callbacks?.label?.call(this, item);
              return item.parsed.y === null ? "" : `${item.dataset.label}: ${formatInflation(item.parsed.y)}`;
            },
          },
        },
      },
    };
  }, [logScale, hasInflation, isDarkTheme]);

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
          plugins={showInflation ? inflationBandPlugins : undefined}
          onRangeChange={setVisibleRange}
          resetKey={resetKey}
        />
      </div>
    </div>
  );
}

export const ValueChart = memo(ValueChartImpl);

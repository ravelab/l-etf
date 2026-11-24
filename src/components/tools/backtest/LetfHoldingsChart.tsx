"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Chart as ChartJS, Filler, type ChartData, type TooltipItem } from "chart.js";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { Button } from "@/components/ui/Button";
import { createValueChartOptions } from "@/lib/chart-options";
import { formatCompactMultiple } from "@/lib/format";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import { useIsDarkTheme } from "@/lib/hooks/use-is-dark-theme";
import { getVisibleIndexBounds, selectSampledIndices, type VisibleRange } from "@/lib/chart-resampling";
import { logAxisFloor, shareAreaBandEdges } from "@/lib/share-area-bands";
import { fitLogTrend } from "@/lib/log-trend";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";
import type { LetfFundHoldings } from "@/lib/simulation/letf-fund-holdings";

ChartJS.register(Filler);

const MAX_VISIBLE_POINTS = 1800;

/**
 * Fixed colors so a ticker keeps its color whichever assets a run holds. Each
 * sleeve's LETF and the basket that replaces it share a family — warm for the SPX
 * sleeve (UPRO, BRK.B, GLDM), blue for the NDX sleeve (TQQQ, VGSH) — so a switch
 * reads as the same sleeve changing shade, not a new series appearing.
 */
const ASSET_COLORS: Readonly<Record<string, { h: number; s: number; l: number }>> = {
  UPRO: { h: 24, s: 85, l: 52 },
  "BRK.B": { h: 4, s: 70, l: 46 },
  GLDM: { h: 44, s: 85, l: 50 },
  TQQQ: { h: 218, s: 75, l: 52 },
  VGSH: { h: 192, s: 70, l: 46 },
  SGOV: { h: 175, s: 60, l: 42 },
};

function assetColor(asset: string, index: number, isDark: boolean, alpha: number): string {
  if (asset === "Cash") return isDark ? `hsl(0 0% 70% / ${alpha})` : `hsl(0 0% 45% / ${alpha})`;
  const { h, s, l } = ASSET_COLORS[asset] ?? { h: (index * 67) % 360, s: 70, l: 50 };
  return `hsl(${h} ${s}% ${isDark ? l + 6 : l - 8}% / ${alpha})`;
}

function formatGrowth(rate: number): string {
  const pct = rate * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%/yr`;
}

/** A date to show as if hovered; a new `key` re-shows the same date. */
export type HoldingsChartFocus = { date: string; key: number; scroll: boolean };

/** Index of `date` in ascending `dates`, or of the first close after it. */
function indexOnOrAfter(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface LetfHoldingsChartProps {
  holdings: LetfFundHoldings;
  focus?: HoldingsChartFocus | null;
  /** What the chart shows, above it. */
  caption: ReactNode;
  testId: string;
  /** Monthly CPI, as for the results table's Real CAGR; without it only nominal figures show. */
  monthlyCpi?: ReadonlyArray<{ date: string; value: number }>;
}

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Amounts read as multiples of the starting investment (10x, 13Kx), like the results table. */
function formatAmount(value: number): string {
  return formatCompactMultiple(value / CONSTANT_INITIAL_INVESTMENT);
}

/** Compound annual rate between two points; null without a positive span. */
function annualRate(fromValue: number, toValue: number, fromTime: number, toTime: number): number | null {
  const years = (toTime - fromTime) / MS_PER_YEAR;
  if (!(years > 0) || !(fromValue > 0) || !(toValue > 0)) return null;
  return Math.pow(toValue / fromValue, 1 / years) - 1;
}

function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(2)}%`;
}

function LetfHoldingsChartImpl({ holdings, caption, testId, focus = null, monthlyCpi }: LetfHoldingsChartProps) {
  const { dates, assets, values } = holdings;
  const [logScale, setLogScale] = useState(true);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const isDarkTheme = useIsDarkTheme();

  const labelTimes = useMemo(() => dates.map((date) => new Date(date).getTime()), [dates]);
  const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
  const dollarYearShares = useMemo(() => {
    // Integrate nominal holdings across calendar time using every close in view.
    // The time conversion to years cancels when each area is divided by the total.
    const areas = assets.map((asset) => {
      const series = values[asset];
      let area = 0;
      for (let i = startIndex + 1; i <= endIndex; i++) {
        area += (series[i - 1] + series[i]) / 2 * (labelTimes[i] - labelTimes[i - 1]);
      }
      return area;
    });
    const total = areas.reduce((sum, area) => sum + area, 0);
    return total > 0 ? areas.map((area) => (area / total * 100).toFixed(2) + "%") : [];
  }, [assets, values, labelTimes, startIndex, endIndex]);
  const totals = useMemo(
    () => dates.map((_, k) => assets.reduce((sum, asset) => sum + (values[asset][k] ?? 0), 0)),
    [dates, assets, values]
  );
  // After inflation: each close deflated to the chart's first date's dollars with the
  // CPI ratio the results table's Real CAGR uses.
  const realTotals = useMemo(() => {
    if (!monthlyCpi || monthlyCpi.length < 2 || dates.length === 0) return null;
    const cpi = monthlyCpi as Array<{ date: string; value: number }>;
    return totals.map((total, k) => total / cpiIndexRatioEndOverStart(cpi, dates[0], dates[k]));
  }, [monthlyCpi, dates, totals]);

  const focusIndex = focus && dates.length > 0 ? indexOnOrAfter(dates, focus.date) : null;
  const chartFocus = useMemo(
    () => (focus && focusIndex !== null ? { label: dates[focusIndex], key: focus.key } : null),
    [focus, focusIndex, dates]
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focus?.scroll) containerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);

  // Bands are rebuilt from the points in view so the log floor follows the zoom.
  // On Log a straight trend line through the points in view, re-fitted on zoom.
  // A focused close is always drawn, so its tooltip shows that day, not a neighbour.
  const { data, sourceIndices, floor, trendValues, rangeStats } = useMemo(() => {
    const sampled = selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS);
    const indices = focusIndex !== null && focusIndex >= startIndex && focusIndex <= endIndex && !sampled.includes(focusIndex)
      ? [...sampled, focusIndex].sort((a, b) => a - b)
      : sampled;
    const axisFloor = logScale ? logAxisFloor(indices.map((k) => totals[k])) : 0;
    const edges = shareAreaBandEdges(
      assets.map((asset) => indices.map((k) => values[asset][k] ?? 0)),
      { logScale, floor: axisFloor }
    );
    const trend = logScale ? fitLogTrend(indices.map((k) => labelTimes[k]), indices.map((k) => totals[k])) : null;
    const realTrend = trend && realTotals
      ? fitLogTrend(indices.map((k) => labelTimes[k]), indices.map((k) => realTotals[k]))
      : null;
    const first = indices[0];
    const last = indices[indices.length - 1];
    const stats = first === undefined || last === undefined ? null : {
      startDate: dates[first],
      endDate: dates[last],
      cagr: annualRate(totals[first], totals[last], labelTimes[first], labelTimes[last]),
      realCagr: realTotals ? annualRate(realTotals[first], realTotals[last], labelTimes[first], labelTimes[last]) : null,
      endValue: totals[last],
      endRealValue: realTotals?.[last] ?? null,
    };
    const trendColor = isDarkTheme ? "rgba(255, 255, 255, 0.85)" : "rgba(15, 23, 42, 0.8)";
    const chartData: ChartData<"line"> = {
      labels: indices.map((k) => dates[k]),
      datasets: [...assets.map((asset, a) => ({
        label: asset,
        data: edges[a],
        fill: a === 0 ? "start" : "-1",
        backgroundColor: assetColor(asset, a, isDarkTheme, isDarkTheme ? 0.55 : 0.45),
        borderColor: assetColor(asset, a, isDarkTheme, 1),
        borderWidth: a === assets.length - 1 ? (isDarkTheme ? 1 : 1.4) : 0,
        pointRadius: 0,
        pointHitRadius: 4,
      })),
      ...(trend
        ? [{
            // The line is drawn through the nominal values; its label gives the real
            // rate when CPI is loaded, the nominal one otherwise.
            label: realTrend ? `Trend real ${formatGrowth(realTrend.annualGrowth)}` : `Trend ${formatGrowth(trend.annualGrowth)}`,
            data: trend.values,
            fill: false,
            borderColor: trendColor,
            backgroundColor: trendColor,
            borderWidth: 1.4,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHitRadius: 4,
          }]
        : [])],
    };
    return { data: chartData, sourceIndices: indices, floor: axisFloor, trendValues: trend?.values ?? null, rangeStats: stats };
  }, [labelTimes, startIndex, endIndex, logScale, totals, realTotals, assets, values, dates, isDarkTheme, focusIndex]);

  const options = useMemo(() => {
    const base = createValueChartOptions(logScale, { formatValue: formatAmount });
    const sourceIndexOf = (item: TooltipItem<"line">) => sourceIndices[item.dataIndex] ?? item.dataIndex;
    return {
      ...base,
      plugins: {
        ...base.plugins,
        // Bands have no border to draw a line swatch with: show their fill instead.
        legend: {
          ...base.plugins?.legend,
          labels: {
            ...base.plugins?.legend?.labels,
            pointStyle: "rect" as const,
            generateLabels: (chart: ChartJS<"line">) =>
              ChartJS.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
                const share = dollarYearShares[item.datasetIndex ?? -1];
                return share ? { ...item, text: `${item.text} ${share}` } : item;
              }),
          },
        },
        tooltip: {
          ...base.plugins?.tooltip,
          // Band edges are positions, not money: report each asset's own dollars.
          filter: (item: TooltipItem<"line">) => item.datasetIndex >= assets.length
            || (values[assets[item.datasetIndex]]?.[sourceIndexOf(item)] ?? 0) > 0,
          itemSort: (a: TooltipItem<"line">, b: TooltipItem<"line">) => b.datasetIndex - a.datasetIndex,
          callbacks: {
            ...base.plugins?.tooltip?.callbacks,
            label: (item: TooltipItem<"line">) => {
              if (item.datasetIndex >= assets.length) {
                return `Trend: ${formatAmount(trendValues?.[item.dataIndex] ?? 0)}`;
              }
              const k = sourceIndexOf(item);
              const asset = assets[item.datasetIndex];
              const value = values[asset]?.[k] ?? 0;
              const total = totals[k] ?? 0;
              const pct = total > 0 ? ` (${((value / total) * 100).toFixed(1)}%)` : "";
              return `${asset}: ${formatAmount(value)}${pct}`;
            },
            labelColor: (item: TooltipItem<"line">) => {
              const color = String(item.dataset.borderColor);
              return { borderColor: color, backgroundColor: color };
            },
            footer: (items: TooltipItem<"line">[]) => {
              const first = items[0];
              if (!first) return "";
              const k = sourceIndexOf(first);
              const total = `Total: ${formatAmount(totals[k] ?? 0)}`;
              return realTotals
                ? [total, `After inflation: ${formatAmount(realTotals[k] ?? 0)}`]
                : total;
            },
          },
        },
      },
      scales: {
        ...base.scales,
        y: {
          ...base.scales?.y,
          min: floor,
          // The floor is an arbitrary value just under the data, and its label lands
          // on top of the round tick above it: leave it unlabelled.
          afterTickToLabelConversion: (axis: { ticks: Array<{ value: number; label?: string | string[] }> }) => {
            for (const tick of axis.ticks) if (tick.value === floor) tick.label = "";
          },
        },
      },
    };
  }, [logScale, sourceIndices, values, assets, totals, realTotals, floor, trendValues, dollarYearShares]);

  const resetKey = `${dates[0] ?? ""}|${dates[dates.length - 1] ?? ""}|${assets.join(",")}`;

  return (
    <div className="mb-4 scroll-mt-4" ref={containerRef}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 text-xs text-muted">
          {caption} Legend percentages show each holding’s share of nominal dollar-years in view.
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant={logScale ? "primary" : "ghost"} size="sm" onClick={() => setLogScale(true)}>
            Log
          </Button>
          <Button variant={!logScale ? "primary" : "ghost"} size="sm" onClick={() => setLogScale(false)}>
            Linear
          </Button>
        </div>
      </div>
      <div className="h-[320px]" data-testid={testId}>
        <ZoomableChart
          data={data}
          options={options}
          onRangeChange={setVisibleRange}
          resetKey={resetKey}
          focus={chartFocus}
        />
      </div>
      {rangeStats && (
        <p data-testid={`${testId}-range-stats`} className="mt-2 text-xs text-muted tabular-nums">
          {rangeStats.startDate} – {rangeStats.endDate}: CAGR{" "}
          <span className="text-foreground">{formatRate(rangeStats.cagr)}</span>
          {realTotals && (
            <>
              {" · "}Real CAGR <span className="text-foreground">{formatRate(rangeStats.realCagr)}</span>
            </>
          )}
          {" · "}ends at <span className="text-foreground">{formatAmount(rangeStats.endValue)}</span>
          {rangeStats.endRealValue !== null && (
            <>
              {", "}<span className="text-foreground">{formatAmount(rangeStats.endRealValue)}</span> after inflation
            </>
          )}
        </p>
      )}
    </div>
  );
}

export const LetfHoldingsChart = memo(LetfHoldingsChartImpl);

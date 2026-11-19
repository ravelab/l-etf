"use client";

import { memo, useMemo, useState, type ReactNode } from "react";
import { Chart as ChartJS, Filler, type ChartData, type TooltipItem } from "chart.js";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { Button } from "@/components/ui/Button";
import { createValueChartOptions } from "@/lib/chart-options";
import { formatCompactCurrency } from "@/lib/format";
import { useIsDarkTheme } from "@/lib/hooks/use-is-dark-theme";
import { getVisibleIndexBounds, selectSampledIndices, type VisibleRange } from "@/lib/chart-resampling";
import { logAxisFloor, shareAreaBandEdges } from "@/lib/share-area-bands";
import { fitLogTrend } from "@/lib/log-trend";
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

interface LetfHoldingsChartProps {
  holdings: LetfFundHoldings;
  /** What the chart shows, above it. */
  caption: ReactNode;
  testId: string;
}

function LetfHoldingsChartImpl({ holdings, caption, testId }: LetfHoldingsChartProps) {
  const { dates, assets, values } = holdings;
  const [logScale, setLogScale] = useState(true);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const isDarkTheme = useIsDarkTheme();

  const labelTimes = useMemo(() => dates.map((date) => new Date(date).getTime()), [dates]);
  const totals = useMemo(
    () => dates.map((_, k) => assets.reduce((sum, asset) => sum + (values[asset][k] ?? 0), 0)),
    [dates, assets, values]
  );

  // Bands are rebuilt from the points in view so the log floor follows the zoom.
  // On Log a straight trend line through the points in view, re-fitted on zoom.
  const { data, sourceIndices, floor, trendValues } = useMemo(() => {
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    const indices = selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS);
    const axisFloor = logScale ? logAxisFloor(indices.map((k) => totals[k])) : 0;
    const edges = shareAreaBandEdges(
      assets.map((asset) => indices.map((k) => values[asset][k] ?? 0)),
      { logScale, floor: axisFloor }
    );
    const trend = logScale ? fitLogTrend(indices.map((k) => labelTimes[k]), indices.map((k) => totals[k])) : null;
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
            label: `Trend ${formatGrowth(trend.annualGrowth)}`,
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
    return { data: chartData, sourceIndices: indices, floor: axisFloor, trendValues: trend?.values ?? null };
  }, [labelTimes, visibleRange, logScale, totals, assets, values, dates, isDarkTheme]);

  const options = useMemo(() => {
    const base = createValueChartOptions(logScale, { formatValue: formatCompactCurrency });
    const sourceIndexOf = (item: TooltipItem<"line">) => sourceIndices[item.dataIndex] ?? item.dataIndex;
    return {
      ...base,
      plugins: {
        ...base.plugins,
        // Bands have no border to draw a line swatch with: show their fill instead.
        legend: {
          ...base.plugins?.legend,
          labels: { ...base.plugins?.legend?.labels, pointStyle: "rect" as const },
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
                return `Trend: ${formatCompactCurrency(trendValues?.[item.dataIndex] ?? 0)}`;
              }
              const k = sourceIndexOf(item);
              const asset = assets[item.datasetIndex];
              const value = values[asset]?.[k] ?? 0;
              const total = totals[k] ?? 0;
              const pct = total > 0 ? ` (${((value / total) * 100).toFixed(1)}%)` : "";
              return `${asset}: ${formatCompactCurrency(value)}${pct}`;
            },
            labelColor: (item: TooltipItem<"line">) => {
              const color = String(item.dataset.borderColor);
              return { borderColor: color, backgroundColor: color };
            },
            footer: (items: TooltipItem<"line">[]) => {
              const first = items[0];
              return first ? `Total: ${formatCompactCurrency(totals[sourceIndexOf(first)] ?? 0)}` : "";
            },
          },
        },
      },
      scales: {
        ...base.scales,
        y: { ...base.scales?.y, min: floor },
      },
    };
  }, [logScale, sourceIndices, values, assets, totals, floor, trendValues]);

  const resetKey = `${dates[0] ?? ""}|${dates[dates.length - 1] ?? ""}|${assets.join(",")}`;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 text-xs text-muted">{caption}</div>
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
        <ZoomableChart data={data} options={options} onRangeChange={setVisibleRange} resetKey={resetKey} />
      </div>
    </div>
  );
}

export const LetfHoldingsChart = memo(LetfHoldingsChartImpl);

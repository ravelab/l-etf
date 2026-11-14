"use client";

import { memo, useMemo, useState } from "react";
import type { ChartData, TooltipItem } from "chart.js";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { Button } from "@/components/ui/Button";
import { createValueChartOptions } from "@/lib/chart-options";
import { formatCompactCurrency } from "@/lib/format";
import { useIsDarkTheme } from "@/lib/hooks/use-is-dark-theme";
import {
  getVisibleIndexBounds,
  pickLineChartIndices,
  selectSampledIndices,
  type VisibleRange,
} from "@/lib/chart-resampling";
import { CASH_ASSET, type DailyAssetValues } from "@/lib/simulation/futures-asset-values";

const MAX_VISIBLE_POINTS = 1800;
/**
 * Drawn as dots: SGOV is the account's buffer, sold first whenever cash is needed
 * and topped back up, and Cash is whatever the sweep band leaves behind, so a line
 * joining their days reads as a column of spikes.
 */
const DOTTED_ASSETS = new Set(["SGOV", CASH_ASSET]);

/**
 * A day the asset is not held is a gap, not a zero: a log axis cannot draw zero,
 * and on a linear one the drop to the floor reads as a crash. A negative (a
 * short cash debit) only exists on the linear axis.
 */
function heldOrGap(value: number | undefined, logScale: boolean): number | null {
  if (value == null || !Number.isFinite(value) || value === 0) return null;
  return logScale && value < 0 ? null : value;
}

function FuturesHoldingsChartImpl({ dates, values }: { dates: string[]; values: DailyAssetValues }) {
  const [logScale, setLogScale] = useState(true);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const isDarkTheme = useIsDarkTheme();

  const fullData = useMemo<ChartData<"line">>(() => {
    const lineWidth = isDarkTheme ? 0.8 : 1.2;
    const colorAt = (i: number) =>
      isDarkTheme ? `hsl(${(i * 47) % 360} 85% 55%)` : `hsl(${(i * 47) % 360} 78% 40%)`;
    return {
      labels: dates,
      datasets: Object.entries(values).map(([asset, series], i) => ({
        label: asset,
        data: dates.map((_, k) => heldOrGap(series[k], logScale)),
        borderColor: colorAt(i),
        backgroundColor: DOTTED_ASSETS.has(asset) ? colorAt(i) : "transparent",
        borderWidth: lineWidth,
        ...(DOTTED_ASSETS.has(asset)
          ? { showLine: false, pointRadius: 1, pointBorderWidth: 0, pointHoverRadius: 3 }
          : { pointRadius: 0 }),
        pointHitRadius: 4,
      })),
    };
  }, [dates, values, isDarkTheme, logScale]);

  const labelTimes = useMemo(() => dates.map((date) => new Date(date).getTime()), [dates]);

  const data = useMemo(() => {
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    return pickLineChartIndices(fullData, selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS));
  }, [fullData, labelTimes, visibleRange]);

  /** The account's value per date: every entry, drawn or not (a negative on Log is not). */
  const totalByDate = useMemo(() => {
    const series = Object.values(values);
    return new Map(dates.map((date, k) => [date, series.reduce((sum, s) => sum + (s[k] ?? 0), 0)]));
  }, [dates, values]);

  const options = useMemo(() => {
    const base = createValueChartOptions(logScale, { formatValue: formatCompactCurrency });
    return {
      ...base,
      plugins: {
        ...base.plugins,
        tooltip: {
          ...base.plugins?.tooltip,
          callbacks: {
            ...base.plugins?.tooltip?.callbacks,
            footer: (items: TooltipItem<"line">[]) => {
              const first = items[0];
              const date = first ? first.chart.data.labels?.[first.dataIndex] : undefined;
              const total = typeof date === "string" ? totalByDate.get(date) : undefined;
              return total === undefined ? "" : `Total: ${formatCompactCurrency(total)}`;
            },
          },
        },
      },
    };
  }, [logScale, totalByDate]);

  const resetKey = `${dates[0] ?? ""}|${dates[dates.length - 1] ?? ""}|${Object.keys(values).join(",")}`;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 text-xs text-muted">
          Where the account&rsquo;s money is at each close: cash held against each index&rsquo;s futures
          margin, the ETFs, and any other cash. They add up to the account&rsquo;s value; a brief cash
          debit before the next sweep shows only on Linear.
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
      <div className="h-[320px]" data-testid="futures-holdings-chart">
        <ZoomableChart data={data} options={options} onRangeChange={setVisibleRange} resetKey={resetKey} />
      </div>
    </div>
  );
}

export const FuturesHoldingsChart = memo(FuturesHoldingsChartImpl);

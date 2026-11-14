"use client";

import { memo, useMemo, useState } from "react";
import type { ChartData } from "chart.js";
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
import type { DailyAssetValues } from "@/lib/simulation/futures-asset-values";

const MAX_VISIBLE_POINTS = 1800;
const FUTURES_ASSETS = new Set(["ES", "NQ"]);

/** Futures read as notional exposure; ETFs by ticker. */
function assetLabel(asset: string): string {
  return FUTURES_ASSETS.has(asset) ? `${asset} notional` : asset;
}

/**
 * A day the asset is not held is a gap, not a zero: a log axis cannot draw zero,
 * and on a linear one the drop to the floor reads as a crash.
 */
function heldOrGap(value: number | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
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
        label: assetLabel(asset),
        data: dates.map((_, k) => heldOrGap(series[k])),
        borderColor: colorAt(i),
        backgroundColor: "transparent",
        borderWidth: lineWidth,
        pointRadius: 0,
        pointHitRadius: 4,
      })),
    };
  }, [dates, values, isDarkTheme]);

  const labelTimes = useMemo(() => dates.map((date) => new Date(date).getTime()), [dates]);

  const data = useMemo(() => {
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    return pickLineChartIndices(fullData, selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS));
  }, [fullData, labelTimes, visibleRange]);

  const options = useMemo(
    () => createValueChartOptions(logScale, { formatValue: formatCompactCurrency }),
    [logScale]
  );

  const resetKey = `${dates[0] ?? ""}|${dates[dates.length - 1] ?? ""}|${Object.keys(values).join(",")}`;

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="min-w-0 text-xs text-muted">
          Holdings at each close, in dollars. ES and NQ are notional, micros included.
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

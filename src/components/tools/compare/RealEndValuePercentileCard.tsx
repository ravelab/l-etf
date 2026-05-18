"use client";

import { useMemo, useState } from "react";
import type { ChartOptions, Plugin, TooltipItem } from "chart.js";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import { formatAdaptiveMultiple, formatNumber } from "@/lib/format";
import type { StrategyPercentileSeries } from "@/lib/strategy-percentiles";
import { inverseTransformRealEndValue, transformRealEndValue } from "@/lib/strategy-percentiles";

export function RealEndValuePercentileCard({
  series,
}: {
  series: StrategyPercentileSeries[];
}) {
  const [logScale, setLogScale] = useState(true);
  const colors = getChartThemeColors();
  const legendHoverIsolation = createLegendHoverIsolation();

  const oneXLinePlugin = useMemo<Plugin<"line">>(() => ({
    id: "one-x-line",
    afterDatasetsDraw: (chart) => {
      const yScale = chart.scales.y;
      const chartArea = chart.chartArea;
      if (!yScale || !chartArea) return;

      const yValue = transformRealEndValue(CONSTANT_INITIAL_INVESTMENT, logScale);
      const yPixel = yScale.getPixelForValue(yValue);
      if (!Number.isFinite(yPixel)) return;

      const { ctx } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors.emphasisGrid;
      ctx.moveTo(chartArea.left, yPixel);
      ctx.lineTo(chartArea.right, yPixel);
      ctx.stroke();
      ctx.restore();
    },
  }), [logScale, colors.emphasisGrid]);

  const chartData = useMemo(
    () => ({
      datasets: series.map((item) => ({
        label: item.label,
        data: item.points.map((point) => ({
          x: point.x,
          y: transformRealEndValue(point.y, logScale),
        })),
        borderColor: item.color,
        backgroundColor: "transparent",
        borderWidth: 1.5,
        pointRadius: 0,
        pointHitRadius: 5,
        tension: 0,
        fill: false,
      })),
    }),
    [series, logScale]
  );

  const resetKey = useMemo(
    () =>
      series
        .map((item) => `${item.label}:${item.points.map((point) => point.y.toFixed(4)).join(",")}`)
        .join("|") + `|${logScale ? "log" : "linear"}`,
    [series, logScale]
  );

  const yBounds = useMemo(() => {
    const rawValues = series
      .flatMap((item) => item.points.map((point) => point.y))
      .filter(Number.isFinite);
    if (rawValues.length === 0) {
      return {
        min: transformRealEndValue(0, logScale),
        max: transformRealEndValue(CONSTANT_INITIAL_INVESTMENT, logScale),
      };
    }

    const transformedValues = rawValues.map((v) => transformRealEndValue(v, logScale));
    const max = Math.max(...transformedValues);
    const min = transformRealEndValue(0, logScale);
    const spread = Math.max(0, max - min) * 0.08;

    return {
      min,
      max: max + spread,
    };
  }, [series, logScale]);

  const chartOptions = useMemo(() => {
    const colors = getChartThemeColors();
    return {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false as const,
      interaction: {
        mode: "index" as const,
        axis: "x" as const,
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: colors.legendText,
            usePointStyle: true,
            pointStyle: "line",
            padding: 16,
            font: { size: 11 },
          },
          ...legendHoverIsolation,
        },
          tooltip: {
            mode: "index" as const,
            intersect: false,
            callbacks: {
              title: (items: TooltipItem<"line">[]) => `${formatNumber(Number(items[0]?.parsed.x ?? 0))}% percentile`,
              label: (item: TooltipItem<"line">) =>
                `${item.dataset.label}: ${formatAdaptiveMultiple(inverseTransformRealEndValue(Number(item.parsed.y ?? 0), logScale) / CONSTANT_INITIAL_INVESTMENT)}`,
            },
          },
        },
      scales: {
        x: {
          type: "linear" as const,
          min: 0,
          max: 100,
          ticks: {
            color: colors.tickText,
            callback: (value: number | string) => `${formatNumber(Number(value))}%`,
          },
          grid: { color: colors.grid },
        },
        y: {
          type: "linear" as const,
          min: yBounds.min,
          max: yBounds.max,
          afterBuildTicks: (axis) => {
            const oneXTick = transformRealEndValue(CONSTANT_INITIAL_INVESTMENT, logScale);
            const alreadyIncluded = axis.ticks.some((tick) => Math.abs(tick.value - oneXTick) < 1e-9);
            if (alreadyIncluded || oneXTick < yBounds.min || oneXTick > yBounds.max) return;
            axis.ticks.push({ value: oneXTick });
            axis.ticks.sort((a, b) => a.value - b.value);
          },
          ticks: {
            color: colors.tickText,
            callback: (value: number | string) => `${formatAdaptiveMultiple(inverseTransformRealEndValue(Number(value), logScale) / CONSTANT_INITIAL_INVESTMENT)}`,
          },
          grid: { color: colors.grid },
        },
      },
      animation: { duration: 0 },
    } satisfies ChartOptions<"line">;
  }, [yBounds, logScale, legendHoverIsolation]);

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Real End Value by Percentile</h2>
          <p className="text-xs text-muted">
            Left is the worst rolling window, right is the best. Y-axis shows inflation-adjusted end value as a multiple of the initial investment.
          </p>
        </div>
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
      <div className="h-[480px]">
        <ZoomableChart data={chartData} options={chartOptions} resetKey={resetKey} plugins={[oneXLinePlugin]} />
      </div>
    </Card>
  );
}

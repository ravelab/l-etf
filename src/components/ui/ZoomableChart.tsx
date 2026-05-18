"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Line } from "react-chartjs-2";
import type { ChartData, ChartOptions, Plugin } from "chart.js";
import { Chart as ChartJS } from "chart.js";
import "chartjs-adapter-date-fns";
import { Button } from "./Button";
import { ensureChartJSRegistered } from "./ChartJSInitializer";
import type { VisibleRange } from "@/lib/chart-resampling";

interface ZoomableChartProps {
  data: ChartData<"line">;
  options: ChartOptions<"line">;
  onRangeChange?: (range: VisibleRange | null) => void;
  resetKey?: string;
  plugins?: Plugin<"line">[];
}

interface TooltipBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ZoomRange {
  min: number;
  max: number;
}

type ZoomableChartInstance = ChartJS<"line"> & {
  resetZoom?: () => void;
};

// Register zoom plugin once at module level to avoid race conditions
let zoomPluginRegistered = false;
let zoomPluginRegistering = false;


function onZoomPluginReady() {
  zoomPluginRegistered = true;
}

export function ZoomableChart({ data, options, onRangeChange, resetKey, plugins }: ZoomableChartProps) {
  const chartRef = useRef<ZoomableChartInstance | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomRange, setZoomRange] = useState<ZoomRange | null>(null);
  const [tooltipBox, setTooltipBox] = useState<TooltipBox | null>(null);
  const lastTooltipKeyRef = useRef<string>("");
  const dataSignature = useMemo(() => {
    const labels = Array.isArray(data.labels) ? data.labels : [];
    const firstLabel = labels.length > 0 ? String(labels[0]) : "";
    const lastLabel = labels.length > 0 ? String(labels[labels.length - 1]) : "";
    return `${labels.length}|${firstLabel}|${lastLabel}|${data.datasets.length}`;
  }, [data.labels, data.datasets.length]);
  const effectiveResetKey = resetKey ?? dataSignature;

  useEffect(() => {
    // Ensure ChartJS is registered first
    ensureChartJSRegistered();

    if (zoomPluginRegistered || zoomPluginRegistering) {
      return;
    }

    zoomPluginRegistering = true;
    import("chartjs-plugin-zoom")
      .then((mod) => {
        ChartJS.register(mod.default);
        onZoomPluginReady();
      })
      .catch(() => {
        onZoomPluginReady();
      });
  }, []);

  useEffect(() => {
    // Defer state updates to avoid cascading render warnings
    Promise.resolve().then(() => {
      setZoomRange(null);
      setIsZoomed(false);
      const chart = chartRef.current;
      if (chart?.resetZoom) {
        chart.resetZoom();
      }
    });
  }, [effectiveResetKey]);

  useEffect(() => {
    onRangeChange?.(zoomRange);
  }, [zoomRange, onRangeChange]);

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const chart = chartRef.current;
      if (!chart) return;

      const xScale = chart.scales.x;
      if (!xScale) return;

      const rect = chart.canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const chartArea = chart.chartArea;
      if (
        chartArea &&
        (
          canvasX < chartArea.left ||
          canvasX > chartArea.right ||
          canvasY < chartArea.top ||
          canvasY > chartArea.bottom
        )
      ) {
        return;
      }
      const clickValue = xScale.getValueForPixel(canvasX);
      if (clickValue == null) return;

      const currentMin = xScale.min;
      const currentMax = xScale.max;
      const currentRange = currentMax - currentMin;

      const isCategory = xScale.type === "category";
      const isLinear = xScale.type === "linear";

      let newMin: number;
      let newMax: number;

      if (isCategory) {
        // Category axis: min/max are label indices
        if (currentRange <= 3) return; // minimum ~3 labels visible

        const newRange = Math.max(3, Math.round(Math.sqrt(currentRange)));
        const halfRange = newRange / 2;
        const totalLabels = (data.labels?.length ?? 0) - 1;

        newMin = Math.round(clickValue - halfRange);
        newMax = Math.round(clickValue + halfRange);

        if (newMin < 0) { newMin = 0; newMax = newRange; }
        if (newMax > totalLabels) { newMax = totalLabels; newMin = totalLabels - newRange; }
        newMin = Math.max(0, newMin);
      } else if (isLinear) {
        if (currentRange <= 1) return;

        const newRange = Math.max(1, Math.sqrt(currentRange));
        const halfRange = newRange / 2;

        const originalMin = xScale.options.min;
        const originalMax = xScale.options.max;
        const dataMin = typeof originalMin === "number" ? originalMin : currentMin;
        const dataMax = typeof originalMax === "number" ? originalMax : currentMax;

        newMin = clickValue - halfRange;
        newMax = clickValue + halfRange;

        if (newMin < dataMin) { newMin = dataMin; newMax = newMin + newRange; }
        if (newMax > dataMax) { newMax = dataMax; newMin = newMax - newRange; }
        newMin = Math.max(newMin, dataMin);
      } else {
        // Time axis: min/max are timestamps in milliseconds
        const oneYearMs = 365.25 * 24 * 60 * 60 * 1000;
        if (currentRange <= oneYearMs) return;

        const currentRangeYears = currentRange / oneYearMs;
        const newRangeMs = Math.max(1, Math.sqrt(currentRangeYears)) * oneYearMs;
        const halfRange = newRangeMs / 2;

        const originalMin = xScale.options.min;
        const originalMax = xScale.options.max;
        const dataMin = typeof originalMin === "number" ? originalMin : currentMin;
        const dataMax = typeof originalMax === "number" ? originalMax : currentMax;

        newMin = clickValue - halfRange;
        newMax = clickValue + halfRange;

        if (newMin < dataMin) { newMin = dataMin; newMax = newMin + newRangeMs; }
        if (newMax > dataMax) { newMax = dataMax; newMin = newMax - newRangeMs; }
        newMin = Math.max(newMin, dataMin);
      }

      setZoomRange({ min: newMin, max: newMax });
      setIsZoomed(true);
    },
    [data.labels]
  );

  const handleResetZoom = useCallback(() => {
    setZoomRange(null);
    setIsZoomed(false);
    
    // Also call internal resetZoom if chart exists
    const chart = chartRef.current;
    if (chart?.resetZoom) {
      chart.resetZoom();
    }
  }, []);

  const zoomOptions = useMemo((): ChartOptions<"line"> => {
    const base: ChartOptions<"line"> = {
      ...options,
      plugins: {
        ...options.plugins,
        zoom: {
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: false },
            drag: { enabled: false },
          },
          pan: { enabled: false },
        },
      },
    };

    // Force the plot area to extend to the canvas right edge so the chart's
    // right edge lines up with sibling tables/cards. By default chart.js
    // reserves variable space at the rightmost tick label, which can leave a
    // visible gap on the right.
    const xExisting = (base.scales?.x ?? {}) as Record<string, unknown> & {
      afterFit?: (axis: { paddingRight: number }) => void;
    };
    base.scales = {
      ...base.scales,
      x: {
        ...xExisting,
        afterFit: (axis) => {
          xExisting.afterFit?.(axis);
          axis.paddingRight = 16;
        },
        ...(zoomRange
          ? { min: zoomRange.min, max: zoomRange.max }
          : {}),
      },
    };

    return base;
  }, [options, zoomRange]);

  const tooltipTrackerPlugin = useMemo<Plugin<"line">>(() => ({
    id: "tooltip-close-tracker",
    afterDraw: (chart) => {
      const tt = (chart as ChartJS<"line"> & { tooltip?: { opacity: number; x: number; y: number; width: number; height: number; dataPoints?: unknown[] } }).tooltip;
      let next: TooltipBox | null = null;
      if (tt && tt.opacity > 0 && Array.isArray(tt.dataPoints) && tt.dataPoints.length > 0) {
        next = { x: tt.x, y: tt.y, width: tt.width, height: tt.height };
      }
      const key = next ? `${next.x}|${next.y}|${next.width}|${next.height}` : "";
      if (key === lastTooltipKeyRef.current) return;
      lastTooltipKeyRef.current = key;
      // Defer setState out of the draw cycle to avoid re-entrancy
      Promise.resolve().then(() => setTooltipBox(next));
    },
  }), []);

  const mergedPlugins = useMemo(
    () => (plugins ? [...plugins, tooltipTrackerPlugin] : [tooltipTrackerPlugin]),
    [plugins, tooltipTrackerPlugin]
  );

  const handleCloseTooltip = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chart = chartRef.current;
    if (!chart) return;
    const tooltip = (chart as ChartJS<"line"> & {
      tooltip?: { setActiveElements: (elements: unknown[], position: { x: number; y: number }) => void };
    }).tooltip;
    tooltip?.setActiveElements([], { x: 0, y: 0 });
    chart.setActiveElements([]);
    chart.update();
    lastTooltipKeyRef.current = "";
    setTooltipBox(null);
  }, []);

  const handleToggleAllVisibility = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chart = chartRef.current;
    if (!chart) return;

    const anyVisible = chart.data.datasets.some((_, i) => chart.isDatasetVisible(i));
    chart.data.datasets.forEach((_, i) => {
      chart.setDatasetVisibility(i, !anyVisible);
    });
    chart.update();
  }, []);

  const showTooltipClose = tooltipBox != null;
  const closeButtonSize = 22;

  return (
    <div className="relative h-full">
      <Line
        ref={chartRef}
        data={data}
        options={zoomOptions}
        onClick={handleClick}
        plugins={mergedPlugins}
      />
      <div className="absolute top-0 right-0 flex flex-row items-center gap-2 px-2 pt-0 pb-2 z-10">
        <button
          type="button"
          onClick={handleToggleAllVisibility}
          className="text-muted hover:text-foreground text-sm leading-none px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          title="Toggle all lines"
          aria-label="Toggle all lines"
        >
          ✕
        </button>
        {isZoomed && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-6 px-2"
            onClick={handleResetZoom}
          >
            Reset Zoom
          </Button>
        )}
      </div>
      {showTooltipClose && tooltipBox && (
        <button
          type="button"
          onClick={handleCloseTooltip}
          onTouchStart={handleCloseTooltip}
          aria-label="Dismiss tooltip"
          className="absolute z-20 flex items-center justify-center rounded-full bg-black/60 text-white text-xs leading-none shadow-md ring-1 ring-white/20 active:bg-black/80"
          style={{
            width: closeButtonSize,
            height: closeButtonSize,
            left: Math.max(0, tooltipBox.x + tooltipBox.width - closeButtonSize / 2),
            top: Math.max(0, tooltipBox.y - closeButtonSize / 2),
            pointerEvents: "auto",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

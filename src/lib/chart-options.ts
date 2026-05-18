import type { ChartData, ChartEvent, ChartOptions, LegendElement, LegendItem, LegendOptions, TooltipItem } from "chart.js";

function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export function getChartThemeColors() {
  const dark = isDarkTheme();
  return {
    legendText: dark ? "#9ca3af" : "#475569",
    tickText: dark ? "#6b7280" : "#475569",
    axisTitleText: dark ? "#888888" : "#475569",
    grid: dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.14)",
    emphasisGrid: dark ? "rgba(255,255,255,0.4)" : "rgba(15,23,42,0.32)",
    emphasisText: dark ? "rgba(255,255,255,0.7)" : "rgba(15,23,42,0.72)",
    tooltipBackground: dark ? "#141516" : "#ffffff",
    tooltipBorder: dark ? "#2a2b2d" : "#cbd5e1",
    tooltipTitle: dark ? "#e5e7eb" : "#0f172a",
    tooltipBody: dark ? "#9ca3af" : "#475569",
  };
}

function formatPercentCompact(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return `${Math.round(rounded)}%`;
  }
  return `${rounded.toFixed(2)}%`;
}

export function createLegendHoverIsolation(): Pick<LegendOptions<"line">, "onClick"> {
  return {
    onClick(this: LegendElement<"line">, _event: ChartEvent, legendItem: LegendItem, legend: LegendElement<"line">) {
      const chart = legend.chart;
      const index = legendItem.datasetIndex;
      if (index == null) return;

      const isVisible = chart.isDatasetVisible(index);
      chart.setDatasetVisibility(index, !isVisible);
      chart.update();
    }
  };
}

type ValueChartOptionsExtras = {
  /** Hide legend entries whose dataset label is empty (e.g. nominal baseline line). */
  omitEmptyLegendLabels?: boolean;
  /** Tooltip series name when dataset label is empty (legend hidden). */
  emptyLineTooltipLabel?: string;
};

/**
 * Create value chart options for portfolio value over time.
 *
 * @param logScale - Whether to use logarithmic scale for Y axis
 * @returns Chart.js options object
 */
export function createValueChartOptions(
  logScale = false,
  extras?: ValueChartOptionsExtras
): ChartOptions<"line"> {
  const colors = getChartThemeColors();
  const legendHoverIsolation = createLegendHoverIsolation();
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index",
      intersect: false,
    },
    plugins: {
      legend: {
        position: "top",
        labels: {
          color: colors.legendText,
          usePointStyle: true,
          pointStyle: "line",
          padding: 16,
          font: { size: 11 },
          ...(extras?.omitEmptyLegendLabels
            ? {
                filter: (legendItem: LegendItem, chartData: ChartData) => {
                  const idx = legendItem.datasetIndex;
                  if (idx === undefined) return true;
                  const lab = chartData.datasets[idx]?.label;
                  return typeof lab === "string" && lab.length > 0;
                },
              }
            : {}),
        },
        ...legendHoverIsolation,
      },
      tooltip: {
        backgroundColor: colors.tooltipBackground,
        borderColor: colors.tooltipBorder,
        borderWidth: 1,
        titleColor: colors.tooltipTitle,
        bodyColor: colors.tooltipBody,
        padding: 10,
        callbacks: {
          label: (item: TooltipItem<"line">) => {
            const value = item.parsed.y;
            if (value === null) return "";
            const raw = item.dataset.label;
            let name: string;
            if (typeof raw === "string" && raw.length === 0 && extras?.omitEmptyLegendLabels) {
              name = extras.emptyLineTooltipLabel ?? "Nominal baseline";
            } else {
              name = String(raw ?? "");
            }
            return `${name}: ${formatPercentCompact(value)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "time",
        time: {
          unit: "year",
          tooltipFormat: "yyyy/MM/dd",
        },
        grid: { color: colors.grid },
        ticks: { color: colors.tickText, maxTicksLimit: 12 },
      },
      y: {
        type: logScale ? "logarithmic" : "linear",
        grid: { color: colors.grid },
        ticks: {
          color: colors.tickText,
          callback: (v: number | string) => formatPercentCompact(Number(v)),
        },
      },
    },
    animation: { duration: 0 },
  };
}

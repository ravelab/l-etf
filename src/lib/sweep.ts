import type { TooltipItem } from "chart.js";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import { formatPercent } from "@/lib/format";
import { scoreRow } from "@/lib/simulation/score";
import { PLATEAU_TOLERANCE, inferSteps, pickPlateauCenter } from "@/lib/simulation/plateau";
import type { SmaComparisonRow } from "@/lib/simulation/types";

/**
 * The row a sweep highlights as best.
 *
 * Not the argmax: the score surface is spiky, and the top row is routinely one
 * step from a cliff. This returns the middle of the flat region around the top
 * row instead, via the same `findPlateau` the offline calibrator uses — so the
 * band a page highlights and the band `calibrate-sma` ships agree rather than
 * differing by an edge-vs-centre step.
 */
export function getBestSweepRow(
  rows: SmaComparisonRow[],
  inflationPct: number,
  /** Fallback years when a row lacks `avgWindowYears`. Matches `SweepComparisonTable`. */
  windowYears = 1
): SmaComparisonRow | null {
  if (rows.length === 0) return null;
  const yearsFor = (r: SmaComparisonRow) =>
    r.avgWindowYears && r.avgWindowYears > 0 ? r.avgWindowYears : windowYears;
  const candidates = rows.map((row) => ({
    item: row,
    coords: [row.parameterValue],
    score: scoreRow(row, inflationPct, yearsFor(row)),
  }));
  return (
    pickPlateauCenter(candidates, {
      tolerance: PLATEAU_TOLERANCE,
      steps: inferSteps(candidates, 1),
    }) ?? null
  );
}

export function sortSweepRowsByPeriod(rows: SmaComparisonRow[]): SmaComparisonRow[] {
  return [...rows].sort((a, b) => a.parameterValue - b.parameterValue);
}

/**
 * Get the average trades per year for a sweep. Returns the value if it's the
 * same for all rows, otherwise undefined.
 */
export function getSweepTradesPerYear(
  rows: SmaComparisonRow[],
  /** Fallback years when a row lacks `avgWindowYears`. Matches `SweepComparisonTable`. */
  windowYears = 1
): number | undefined {
  if (rows.length === 0) return undefined;
  const tradesFor = (r: SmaComparisonRow) => {
    const years = r.avgWindowYears && r.avgWindowYears > 0 ? r.avgWindowYears : windowYears;
    return r.avgTrades / Math.max(1e-9, years);
  };
  const first = tradesFor(rows[0]);
  const allSame = rows.every((r) => Math.abs(tradesFor(r) - first) < 1e-6);
  return allSame ? first : undefined;
}

export function createSweepChartOptions(p: {
  title: (items: TooltipItem<"line">[]) => string;
  xTick: (value: number | string) => string | number;
  xMin?: number;
  xMax?: number;
}) {
  const colors = getChartThemeColors();
  const legendHoverIsolation = createLegendHoverIsolation();
  return {
    responsive: true,
    maintainAspectRatio: false,
    parsing: false as const,
    interaction: {
      mode: "index" as const,
      intersect: false,
    },
    plugins: {
      legend: {
        labels: { color: colors.legendText },
        ...legendHoverIsolation,
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        callbacks: {
          title: p.title,
          label: (item: TooltipItem<"line">) =>
            `${item.dataset.label}: ${formatPercent(item.parsed.y ?? 0)}`,
        },
      },
    },
    scales: {
      x: {
        type: "linear" as const,
        min: p.xMin,
        max: p.xMax,
        ticks: {
          color: colors.tickText,
          callback: p.xTick,
        },
        grid: { color: colors.grid },
      },
      y: {
        ticks: {
          color: colors.tickText,
          callback: (v: number | string) => formatPercent(Number(v)),
        },
        grid: { color: colors.grid },
      },
    },
  };
}

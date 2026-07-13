"use client";

import { useMemo } from "react";
import { Chart } from "react-chartjs-2";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  LogarithmicScale,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type Plugin,
  type TooltipItem,
} from "chart.js";
import { Card } from "@/components/ui/Card";
import { getChartThemeColors } from "@/lib/chart-options";
import type { PricePoint, RatePoint } from "@/lib/simulation/types";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { computeSimulatedRiskOnReturn } from "@/lib/simulation/engine";

ChartJS.register(
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  LogarithmicScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);

const TRADING_DAYS_PER_YEAR = 252;
const BIN_WIDTH_PCT = 2; // x-axis bin width: 2 percentage points of gap
// Bins clipped to [-26%, +26%] so the edge buckets read "≤-24%" / "≥24%";
// any values past ±26% fold into those edge buckets.
const BIN_MIN_PCT = -26;
const BIN_MAX_PCT = 26;

// Match ETF_PRESETS in src/lib/simulation/presets.ts.
const UPRO_LEVERAGE = 3;
const UPRO_ER_PCT = 0.91;
const TQQQ_LEVERAGE = 3;
const TQQQ_ER_PCT = 0.88;

interface BoxStats {
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

function quantile(sortedAsc: number[], p: number): number {
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function summarize(values: number[]): BoxStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    // "min" / "max" here are the 10th / 90th percentile whisker tips.
    // Renaming would ripple through the plugin and tooltip; treating them
    // as "lower whisker" / "upper whisker" is sufficient.
    min: quantile(sorted, 0.1),
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    max: quantile(sorted, 0.9),
  };
}

function binIndexForGap(gapPct: number): number {
  const clipped = Math.min(BIN_MAX_PCT - 1e-9, Math.max(BIN_MIN_PCT, gapPct));
  return Math.floor((clipped - BIN_MIN_PCT) / BIN_WIDTH_PCT);
}

function binLabel(idx: number): string {
  const lo = BIN_MIN_PCT + idx * BIN_WIDTH_PCT;
  const hi = lo + BIN_WIDTH_PCT;
  if (idx === 0) return `≤${hi}%`;
  if (lo + BIN_WIDTH_PCT >= BIN_MAX_PCT) return `≥${lo}%`;
  return `${lo} to ${hi}%`;
}

/**
 * Mirrors computeSimulatedRiskOnReturn — daily-compounded simulated LETF
 * value series, index-aligned with `indexPrices`, starting at 1.
 */
function buildSimulatedLetfValues(
  indexPrices: PricePoint[],
  smaIndex: "sp500" | "nasdaq100",
  leverage: number,
  erPct: number,
  rateLookup: { getRate(date: string): number } | null,
): number[] {
  const erDaily = erPct / 100 / 252;
  const values: number[] = new Array(indexPrices.length);
  if (indexPrices.length === 0) return values;
  values[0] = 1;
  for (let i = 1; i < indexPrices.length; i++) {
    const prev = indexPrices[i - 1].adj_close;
    const curr = indexPrices[i].adj_close;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0 || curr <= 0) {
      values[i] = values[i - 1];
      continue;
    }
    const indexReturn = curr / prev - 1;
    let borrowDaily = 0;
    if (rateLookup) {
      try {
        borrowDaily = rateLookup.getRate(indexPrices[i].date);
      } catch {
        borrowDaily = 0;
      }
    }
    const dailyReturn = computeSimulatedRiskOnReturn(
      indexReturn,
      borrowDaily,
      smaIndex,
      leverage,
      erDaily,
    );
    const factor = 1 + dailyReturn;
    values[i] = values[i - 1] * (Number.isFinite(factor) && factor > 0 ? factor : 1);
  }
  return values;
}

interface SeriesConfig {
  indexPrices: PricePoint[];
  smaPeriod: number;
  letfValues: number[];
}

function buildPoints(
  cfg: SeriesConfig,
  monthlyCpi: Array<{ date: string; value: number }>,
  startDate: string,
  endDate: string,
): Array<{ gap: number; realReturnFactor: number }> {
  const { indexPrices, smaPeriod, letfValues } = cfg;
  if (indexPrices.length === 0 || letfValues.length === 0 || smaPeriod < 2) return [];

  const out: Array<{ gap: number; realReturnFactor: number }> = [];
  for (let i = smaPeriod - 1; i < indexPrices.length; i++) {
    const day = indexPrices[i];
    if (day.date < startDate || day.date > endDate) continue;

    let sum = 0;
    let valid = true;
    for (let k = i - smaPeriod + 1; k <= i; k++) {
      const c = indexPrices[k].close;
      if (!Number.isFinite(c) || c <= 0) {
        valid = false;
        break;
      }
      sum += c;
    }
    if (!valid) continue;
    const sma = sum / smaPeriod;
    if (sma <= 0) continue;

    const dayClose = day.close;
    if (!Number.isFinite(dayClose) || dayClose <= 0) continue;
    const gap = (dayClose / sma - 1) * 100;

    const startEtf = letfValues[i];
    const forwardIdx = i + TRADING_DAYS_PER_YEAR;
    if (forwardIdx >= indexPrices.length) continue;
    const endEtf = letfValues[forwardIdx];
    if (!Number.isFinite(startEtf) || !Number.isFinite(endEtf) || startEtf <= 0 || endEtf <= 0) continue;

    const forwardDate = indexPrices[forwardIdx].date;
    const nominalReturn = endEtf / startEtf;
    const cpiRatio = cpiIndexRatioEndOverStart(monthlyCpi, day.date, forwardDate);
    if (!Number.isFinite(cpiRatio) || cpiRatio <= 0) continue;
    const realReturn = nominalReturn / cpiRatio;
    if (!Number.isFinite(realReturn) || realReturn <= 0) continue;

    out.push({ gap, realReturnFactor: realReturn });
  }
  return out;
}

function bucketize(points: Array<{ gap: number; realReturnFactor: number }>): Array<number[]> {
  const binCount = Math.round((BIN_MAX_PCT - BIN_MIN_PCT) / BIN_WIDTH_PCT);
  const buckets: Array<number[]> = Array.from({ length: binCount }, () => []);
  for (const p of points) {
    if (!Number.isFinite(p.realReturnFactor) || p.realReturnFactor <= 0) continue;
    buckets[binIndexForGap(p.gap)].push(p.realReturnFactor);
  }
  return buckets;
}

function factorToPctLabel(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return "";
  const pct = (factor - 1) * 100;
  const abs = Math.abs(pct);
  if (abs >= 100) return `${pct.toFixed(0)}%`;
  if (abs >= 10) return `${pct.toFixed(0)}%`;
  if (abs >= 1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

interface ForwardReturnVsSmaGapChartProps {
  spxPrices: PricePoint[];
  ndxPrices: PricePoint[];
  rates: RatePoint[];
  monthlyCpi: Array<{ date: string; value: number }>;
  smaPeriodSp: number;
  smaPeriodNq: number;
  startDate: string;
  endDate: string;
}

// chart.js dataset with attached box stats for the whisker/median plugin.
type BoxDataset = {
  label: string;
  data: Array<[number, number] | null>;
  boxStats: Array<BoxStats | null>;
  totalCount: number;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderSkipped: false;
  categoryPercentage: number;
  barPercentage: number;
  whiskerColor: string;
};

const whiskerPlugin: Plugin<"bar"> = {
  id: "boxplotWhiskers",
  afterDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;
    ctx.save();
    chart.data.datasets.forEach((ds, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const meta = chart.getDatasetMeta(datasetIndex);
      const stats = (ds as unknown as { boxStats?: Array<BoxStats | null> }).boxStats;
      const color = (ds as unknown as { whiskerColor?: string }).whiskerColor ?? "#888";
      if (!stats) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.25;
      meta.data.forEach((bar, idx) => {
        const s = stats[idx];
        if (!s) return;
        const bx = bar.x;
        const halfWidth = (bar as unknown as { width: number }).width / 2;
        const yMin = yScale.getPixelForValue(s.min);
        const yMax = yScale.getPixelForValue(s.max);
        const yMedian = yScale.getPixelForValue(s.median);
        const yQ1 = yScale.getPixelForValue(s.q1);
        const yQ3 = yScale.getPixelForValue(s.q3);
        // vertical whisker line through full extent
        ctx.beginPath();
        ctx.moveTo(bx, yMin);
        ctx.lineTo(bx, yMax);
        ctx.stroke();
        // min cap
        ctx.beginPath();
        ctx.moveTo(bx - halfWidth * 0.55, yMin);
        ctx.lineTo(bx + halfWidth * 0.55, yMin);
        ctx.stroke();
        // max cap
        ctx.beginPath();
        ctx.moveTo(bx - halfWidth * 0.55, yMax);
        ctx.lineTo(bx + halfWidth * 0.55, yMax);
        ctx.stroke();
        // median tick (drawn slightly thicker so it reads as the line in the box)
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx - halfWidth, yMedian);
        ctx.lineTo(bx + halfWidth, yMedian);
        ctx.stroke();
        ctx.lineWidth = 1.25;
        // q1/q3 caps within the bar are already drawn by the bar itself, but
        // re-stroke them so the box outline is crisp.
        ctx.beginPath();
        ctx.rect(bx - halfWidth, Math.min(yQ1, yQ3), halfWidth * 2, Math.abs(yQ3 - yQ1));
        ctx.stroke();
      });
    });
    ctx.restore();
  },
};

ChartJS.register(whiskerPlugin);

export function ForwardReturnVsSmaGapChart({
  spxPrices,
  ndxPrices,
  rates,
  monthlyCpi,
  smaPeriodSp,
  smaPeriodNq,
  startDate,
  endDate,
}: ForwardReturnVsSmaGapChartProps) {
  const colors = getChartThemeColors();

  const rateLookup = useMemo(
    () => (rates.length > 0 ? buildRateLookup(rates) : null),
    [rates],
  );

  const uproValues = useMemo(
    () => buildSimulatedLetfValues(spxPrices, "sp500", UPRO_LEVERAGE, UPRO_ER_PCT, rateLookup),
    [spxPrices, rateLookup],
  );
  const tqqqValues = useMemo(
    () => buildSimulatedLetfValues(ndxPrices, "nasdaq100", TQQQ_LEVERAGE, TQQQ_ER_PCT, rateLookup),
    [ndxPrices, rateLookup],
  );

  const uproPoints = useMemo(
    () =>
      buildPoints(
        { indexPrices: spxPrices, smaPeriod: smaPeriodSp, letfValues: uproValues },
        monthlyCpi,
        startDate,
        endDate,
      ),
    [spxPrices, smaPeriodSp, uproValues, monthlyCpi, startDate, endDate],
  );
  const tqqqPoints = useMemo(
    () =>
      buildPoints(
        { indexPrices: ndxPrices, smaPeriod: smaPeriodNq, letfValues: tqqqValues },
        monthlyCpi,
        startDate,
        endDate,
      ),
    [ndxPrices, smaPeriodNq, tqqqValues, monthlyCpi, startDate, endDate],
  );

  const uproBuckets = useMemo(() => bucketize(uproPoints), [uproPoints]);
  const tqqqBuckets = useMemo(() => bucketize(tqqqPoints), [tqqqPoints]);

  const binCount = Math.round((BIN_MAX_PCT - BIN_MIN_PCT) / BIN_WIDTH_PCT);
  const labels = useMemo(
    () => Array.from({ length: binCount }, (_, i) => binLabel(i)),
    [binCount],
  );

  const uproStats = useMemo(() => uproBuckets.map((b) => summarize(b)), [uproBuckets]);
  const tqqqStats = useMemo(() => tqqqBuckets.map((b) => summarize(b)), [tqqqBuckets]);

  // Y-axis bounds must include the whiskers (min/max), not just the box
  // (Q1/Q3) that chart.js sees in its data. Without this, tall whiskers
  // shoot off the top/bottom of the visible chart.
  const yBounds = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const stats of [...uproStats, ...tqqqStats]) {
      if (!stats) continue;
      if (stats.min > 0 && stats.min < lo) lo = stats.min;
      if (stats.max > hi) hi = stats.max;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return null;
    // 4% multiplicative pad on a log axis: divide low / multiply high by 1.04.
    return { min: lo / 1.04, max: hi * 1.04 };
  }, [uproStats, tqqqStats]);

  const data = useMemo((): ChartData<"bar" | "line"> => {
    const uproTotal = uproStats.reduce((acc, s) => acc + (s ? s.count : 0), 0);
    const tqqqTotal = tqqqStats.reduce((acc, s) => acc + (s ? s.count : 0), 0);
    const uproDataset: BoxDataset = {
      label: `UPRO — SMA(${smaPeriodSp})`,
      data: uproStats.map((s) => (s ? ([s.q1, s.q3] as [number, number]) : null)),
      boxStats: uproStats,
      totalCount: uproTotal,
      backgroundColor: "rgba(59, 130, 246, 0.35)",
      borderColor: "rgba(59, 130, 246, 0.95)",
      borderWidth: 1,
      borderSkipped: false,
      categoryPercentage: 0.85,
      barPercentage: 0.9,
      whiskerColor: "rgba(59, 130, 246, 0.95)",
    };
    const tqqqDataset: BoxDataset = {
      label: `TQQQ — SMA(${smaPeriodNq})`,
      data: tqqqStats.map((s) => (s ? ([s.q1, s.q3] as [number, number]) : null)),
      boxStats: tqqqStats,
      totalCount: tqqqTotal,
      backgroundColor: "rgba(249, 115, 22, 0.35)",
      borderColor: "rgba(249, 115, 22, 0.95)",
      borderWidth: 1,
      borderSkipped: false,
      categoryPercentage: 0.85,
      barPercentage: 0.9,
      whiskerColor: "rgba(249, 115, 22, 0.95)",
    };
    const uproMedianLine = {
      type: "line" as const,
      label: "UPRO median",
      data: uproStats.map((s) => (s ? s.median : null)),
      borderColor: "rgba(59, 130, 246, 1)",
      backgroundColor: "rgba(59, 130, 246, 1)",
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 4,
      tension: 0,
      spanGaps: false,
    };
    const tqqqMedianLine = {
      type: "line" as const,
      label: "TQQQ median",
      data: tqqqStats.map((s) => (s ? s.median : null)),
      borderColor: "rgba(249, 115, 22, 1)",
      backgroundColor: "rgba(249, 115, 22, 1)",
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 4,
      tension: 0,
      spanGaps: false,
    };
    const uproFreqLine = {
      type: "line" as const,
      label: "UPRO n/total",
      data: uproStats.map((s) => (s && uproTotal > 0 ? (s.count / uproTotal) * 100 : null)),
      isFreq: true,
      yAxisID: "yFreq",
      borderColor: "rgba(59, 130, 246, 0.55)",
      backgroundColor: "rgba(59, 130, 246, 0.55)",
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 2,
      pointHoverRadius: 3,
      tension: 0,
      spanGaps: false,
    };
    const tqqqFreqLine = {
      type: "line" as const,
      label: "TQQQ n/total",
      data: tqqqStats.map((s) => (s && tqqqTotal > 0 ? (s.count / tqqqTotal) * 100 : null)),
      isFreq: true,
      yAxisID: "yFreq",
      borderColor: "rgba(249, 115, 22, 0.55)",
      backgroundColor: "rgba(249, 115, 22, 0.55)",
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 2,
      pointHoverRadius: 3,
      tension: 0,
      spanGaps: false,
    };
    return {
      labels,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      datasets: [uproDataset, tqqqDataset, uproMedianLine, tqqqMedianLine, uproFreqLine, tqqqFreqLine] as any,
    };
  }, [labels, uproStats, tqqqStats, smaPeriodSp, smaPeriodNq]);

  const options = useMemo<ChartOptions<"bar">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { left: 0, right: 0, top: 4, bottom: 0 },
      },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: colors.legendText,
            font: { size: 11 },
            padding: 16,
            usePointStyle: true,
            pointStyle: "rect",
          },
        },
        tooltip: {
          backgroundColor: colors.tooltipBackground,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          titleColor: colors.tooltipTitle,
          bodyColor: colors.tooltipBody,
          // Suppress tooltip entries for the median connector lines — their
          // value is already shown by the adjacent box body.
          filter(item: TooltipItem<"bar">) {
            const ds = item.dataset as unknown as { boxStats?: Array<BoxStats | null>; isFreq?: boolean };
            return ds.boxStats !== undefined || ds.isFreq === true;
          },
          callbacks: {
            label(item: TooltipItem<"bar">) {
              const ds = item.dataset as unknown as {
                boxStats?: Array<BoxStats | null>;
                totalCount?: number;
                isFreq?: boolean;
                label: string;
              };
              if (ds.isFreq) {
                const v = item.parsed.y;
                return typeof v === "number" && Number.isFinite(v)
                  ? `${ds.label}: ${v.toFixed(1)}%`
                  : `${ds.label}: no data`;
              }
              const s = ds.boxStats?.[item.dataIndex];
              if (!s) return `${ds.label}: no data`;
              const total = ds.totalCount ?? 0;
              const share = total > 0 ? ` (${((s.count / total) * 100).toFixed(1)}% of ${total})` : "";
              return [
                `${ds.label}`,
                `n=${s.count}${share}`,
                `P10 ${factorToPctLabel(s.min)} / Q1 ${factorToPctLabel(s.q1)} / median ${factorToPctLabel(s.median)} / Q3 ${factorToPctLabel(s.q3)} / P90 ${factorToPctLabel(s.max)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "category",
          title: {
            display: true,
            text: "Index − SMA (%)",
            color: colors.axisTitleText,
            font: { size: 11 },
          },
          ticks: { color: colors.tickText, font: { size: 10 } },
          grid: { color: colors.grid },
        },
        y: {
          type: "logarithmic",
          ...(yBounds ? { min: yBounds.min, max: yBounds.max } : {}),
          title: {
            display: true,
            text: "Next-year real return (%)",
            color: colors.axisTitleText,
            font: { size: 11 },
          },
          ticks: {
            color: colors.tickText,
            callback(value) {
              return factorToPctLabel(typeof value === "number" ? value : Number(value));
            },
          },
          grid: { color: colors.grid },
        },
        yFreq: {
          type: "linear",
          position: "right",
          min: 0,
          title: {
            display: true,
            text: "n / total (%)",
            color: colors.axisTitleText,
            font: { size: 11 },
          },
          ticks: {
            color: colors.tickText,
            callback(value) {
              const v = typeof value === "number" ? value : Number(value);
              return `${v}%`;
            },
          },
          // Right-axis gridlines would clutter the log-scaled return grid.
          grid: { drawOnChartArea: false },
        },
      },
    }),
    [colors, yBounds],
  );

  const totalUpro = uproPoints.length;
  const totalTqqq = tqqqPoints.length;

  return (
    <Card className="!p-1 md:!p-5">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-foreground">1-year forward real return by SMA gap</h3>
        <span className="text-xs text-muted">
          {totalUpro} UPRO • {totalTqqq} TQQQ
        </span>
      </div>
      {totalUpro === 0 && totalTqqq === 0 ? (
        <div className="text-sm text-muted">
          Loading or not enough forward data — the chart needs at least 252 trading days of history past each candidate
          date in the selected range.
        </div>
      ) : (
        <div className="h-[460px]">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Chart type="bar" data={data as any} options={options as any} />
        </div>
      )}
    </Card>
  );
}

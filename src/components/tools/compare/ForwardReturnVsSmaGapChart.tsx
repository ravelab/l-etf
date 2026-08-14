"use client";

import { useMemo } from "react";
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
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { getChartThemeColors } from "@/lib/chart-options";
import type { PricePoint, RatePoint } from "@/lib/simulation/types";
import { cpiIndexRatioEndOverStart } from "@/lib/inflation";
import { buildRateLookup } from "@/lib/simulation/borrowing-rate";
import { computeSimulatedRiskOnReturn } from "@/lib/simulation/engine";
import {
  buildLogRaincloudDensity,
  sampleRaincloudValues,
  type RaincloudDensityPoint,
} from "@/lib/raincloud";

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

interface PercentileStats {
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

function summarize(values: number[]): PercentileStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    // "min" / "max" here are the visible P10 / P90 range endpoints.
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

// Invisible bars provide grouped x-positions and tooltip hit regions; the
// plugins render the raincloud and percentile marks themselves.
type RaincloudDataset = {
  type: "bar";
  label: string;
  data: Array<[number, number] | null>;
  percentileStats: Array<PercentileStats | null>;
  totalCount: number;
  backgroundColor: string;
  borderColor: string;
  borderWidth: number;
  borderSkipped: false;
  categoryPercentage: number;
  barPercentage: number;
  percentileColor: string;
  cloudProfiles: Array<RaincloudDensityPoint[]>;
  rainValues: Array<number[]>;
  cloudColor: string;
  rainColor: string;
  raincloudSide: -1 | 1;
};

type RaincloudDatasetFields = Pick<
  RaincloudDataset,
  | "percentileStats"
  | "percentileColor"
  | "cloudProfiles"
  | "rainValues"
  | "cloudColor"
  | "rainColor"
  | "raincloudSide"
>;

const raincloudPlugin: Plugin<"bar"> = {
  id: "raincloudDistributions",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const fields = dataset as unknown as Partial<RaincloudDatasetFields>;
      if (!fields.cloudProfiles || !fields.raincloudSide || !fields.cloudColor) return;
      const meta = chart.getDatasetMeta(datasetIndex);

      meta.data.forEach((element, index) => {
        const profile = fields.cloudProfiles?.[index];
        if (!profile || profile.length < 2) return;
        const bar = element as unknown as { x: number; width: number };
        const halfWidth = Math.max(2, bar.width / 2);
        const baselineX = bar.x;
        const cloudWidth = Math.max(6, halfWidth * 2.1);

        ctx.beginPath();
        profile.forEach((point, pointIndex) => {
          const x = baselineX + fields.raincloudSide! * cloudWidth * point.density;
          const y = yScale.getPixelForValue(point.value);
          if (pointIndex === 0) ctx.moveTo(baselineX, y);
          ctx.lineTo(x, y);
        });
        ctx.lineTo(baselineX, yScale.getPixelForValue(profile.at(-1)!.value));
        ctx.closePath();
        ctx.fillStyle = fields.cloudColor!;
        ctx.fill();
      });
    });

    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.clip();

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const fields = dataset as unknown as Partial<RaincloudDatasetFields>;
      if (!fields.rainValues || !fields.raincloudSide || !fields.rainColor) return;
      const meta = chart.getDatasetMeta(datasetIndex);

      meta.data.forEach((element, index) => {
        const values = fields.rainValues?.[index] ?? [];
        if (values.length === 0) return;
        const bar = element as unknown as { x: number; width: number };
        const halfWidth = Math.max(2, bar.width / 2);
        const pointRadius = Math.min(1.6, Math.max(1.05, halfWidth * 0.24));

        values.forEach((value, pointIndex) => {
          const y = yScale.getPixelForValue(value);
          if (y < chartArea.top || y > chartArea.bottom) return;
          // Golden-ratio spacing gives stable, non-banding jitter without
          // random movement every time Chart.js redraws on hover.
          const jitter = (pointIndex * 0.61803398875 + datasetIndex * 0.271828) % 1;
          const x = bar.x - fields.raincloudSide! * halfWidth * (0.72 + jitter * 0.72);
          ctx.beginPath();
          ctx.arc(x, y, pointRadius, 0, Math.PI * 2);
          ctx.fillStyle = fields.rainColor!;
          ctx.fill();
        });
      });
    });

    ctx.restore();
  },
};

const percentileMarkersPlugin: Plugin<"bar"> = {
  id: "raincloudPercentileMarkers",
  afterDatasetsDraw(chart) {
    const { ctx, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;
    ctx.save();
    chart.data.datasets.forEach((ds, datasetIndex) => {
      if (!chart.isDatasetVisible(datasetIndex)) return;
      const meta = chart.getDatasetMeta(datasetIndex);
      const stats = (ds as unknown as Partial<RaincloudDatasetFields>).percentileStats;
      const color = (ds as unknown as Partial<RaincloudDatasetFields>).percentileColor ?? "#888";
      if (!stats) return;
      ctx.strokeStyle = color;
      meta.data.forEach((bar, idx) => {
        const s = stats[idx];
        if (!s) return;
        const bx = bar.x;
        const halfWidth = Math.max(3, (bar as unknown as { width: number }).width / 2);
        const markers = [
          { value: s.min, width: halfWidth * 0.45, lineWidth: 1.4 },
          { value: s.q1, width: halfWidth * 0.72, lineWidth: 1.6 },
          { value: s.median, width: halfWidth * 1.08, lineWidth: 2.6 },
          { value: s.q3, width: halfWidth * 0.72, lineWidth: 1.6 },
          { value: s.max, width: halfWidth * 0.45, lineWidth: 1.4 },
        ];

        // Slim spine spans P10–P90; tick length encodes percentile rank.
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(bx, yScale.getPixelForValue(s.min));
        ctx.lineTo(bx, yScale.getPixelForValue(s.max));
        ctx.stroke();

        markers.forEach((marker) => {
          const y = yScale.getPixelForValue(marker.value);
          ctx.lineWidth = marker.lineWidth;
          ctx.beginPath();
          ctx.moveTo(bx - marker.width, y);
          ctx.lineTo(bx + marker.width, y);
          ctx.stroke();
        });
      });
    });
    ctx.restore();
  },
};

ChartJS.register(raincloudPlugin, percentileMarkersPlugin);

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

  // Y-axis bounds must include the full visible P10–P90 percentile range.
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
    const uproDataset: RaincloudDataset = {
      type: "bar",
      label: `UPRO — SMA(${smaPeriodSp})`,
      data: uproStats.map((s) => (s ? ([s.min, s.max] as [number, number]) : null)),
      percentileStats: uproStats,
      totalCount: uproTotal,
      backgroundColor: "rgba(59, 130, 246, 0)",
      borderColor: "rgba(59, 130, 246, 0)",
      borderWidth: 0,
      borderSkipped: false,
      categoryPercentage: 0.85,
      barPercentage: 0.55,
      percentileColor: "rgba(59, 130, 246, 0.95)",
      cloudProfiles: uproBuckets.map((bucket, index) => {
        const stats = uproStats[index];
        return stats ? buildLogRaincloudDensity(bucket, stats.min, stats.max) : [];
      }),
      rainValues: uproBuckets.map((bucket) => sampleRaincloudValues(bucket)),
      cloudColor: "rgba(59, 130, 246, 0.38)",
      rainColor: "rgba(59, 130, 246, 0.7)",
      raincloudSide: -1,
    };
    const tqqqDataset: RaincloudDataset = {
      type: "bar",
      label: `TQQQ — SMA(${smaPeriodNq})`,
      data: tqqqStats.map((s) => (s ? ([s.min, s.max] as [number, number]) : null)),
      percentileStats: tqqqStats,
      totalCount: tqqqTotal,
      backgroundColor: "rgba(249, 115, 22, 0)",
      borderColor: "rgba(249, 115, 22, 0)",
      borderWidth: 0,
      borderSkipped: false,
      categoryPercentage: 0.85,
      barPercentage: 0.55,
      percentileColor: "rgba(249, 115, 22, 0.95)",
      cloudProfiles: tqqqBuckets.map((bucket, index) => {
        const stats = tqqqStats[index];
        return stats ? buildLogRaincloudDensity(bucket, stats.min, stats.max) : [];
      }),
      rainValues: tqqqBuckets.map((bucket) => sampleRaincloudValues(bucket)),
      cloudColor: "rgba(249, 115, 22, 0.38)",
      rainColor: "rgba(249, 115, 22, 0.7)",
      raincloudSide: 1,
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
  }, [labels, uproBuckets, uproStats, tqqqBuckets, tqqqStats, smaPeriodSp, smaPeriodNq]);

  const options = useMemo<ChartOptions<"bar">>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      // Surface tooltips for the whole x-bucket while sweeping the cursor
      // anywhere over the chart, rather than requiring pixel-perfect hover
      // on a point or bar.
      interaction: {
        mode: "index",
        intersect: false,
      },
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
            generateLabels(chart) {
              return ChartJS.defaults.plugins.legend.labels.generateLabels(chart).map((item) => {
                if (item.datasetIndex == null) return item;
                const dataset = chart.data.datasets[item.datasetIndex] as unknown as Partial<RaincloudDatasetFields>;
                if (!dataset.cloudColor) return item;
                return {
                  ...item,
                  fillStyle: dataset.cloudColor,
                  strokeStyle: dataset.percentileColor ?? dataset.rainColor,
                  lineWidth: 1.5,
                };
              });
            },
          },
        },
        tooltip: {
          backgroundColor: colors.tooltipBackground,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          titleColor: colors.tooltipTitle,
          bodyColor: colors.tooltipBody,
          // Suppress tooltip entries for the median connector and n/total
          // lines — the raincloud entries already include those values.
          filter(item: TooltipItem<"bar">) {
            const ds = item.dataset as unknown as {
              percentileStats?: Array<PercentileStats | null>;
            };
            return ds.percentileStats !== undefined;
          },
          callbacks: {
            label(item: TooltipItem<"bar">) {
              const ds = item.dataset as unknown as {
                percentileStats?: Array<PercentileStats | null>;
                totalCount?: number;
                label: string;
              };
              const s = ds.percentileStats?.[item.dataIndex];
              if (!s) return `${ds.label}: no data`;
              const total = ds.totalCount ?? 0;
              const share = total > 0 ? ` (${((s.count / total) * 100).toFixed(1)}% of ${total})` : "";
              return [
                `${ds.label}`,
                `n=${s.count}${share}`,
                `P10 ${factorToPctLabel(s.min)} / P25 ${factorToPctLabel(s.q1)} / P50 ${factorToPctLabel(s.median)} / P75 ${factorToPctLabel(s.q3)} / P90 ${factorToPctLabel(s.max)}`,
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
      <div className="mb-2 flex items-start justify-between gap-3 md:items-baseline">
        <h3 className="text-sm font-medium text-foreground">1-year forward real return by SMA gap</h3>
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {totalUpro} UPRO • {totalTqqq} TQQQ
        </span>
      </div>
      {totalUpro === 0 && totalTqqq === 0 ? (
        <div className="text-sm text-muted">
          Loading or not enough forward data — the chart needs at least 252 trading days of history past each candidate
          date in the selected range.
        </div>
      ) : (
        <div>
          <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-muted md:hidden">
            <span>Swipe to explore</span>
            <span aria-hidden="true">→</span>
          </div>
          <div
            className="max-w-full overflow-x-auto overscroll-x-contain pb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:overflow-visible md:pb-0"
            role="region"
            aria-label="Scrollable one-year forward real return chart"
            tabIndex={0}
          >
            <div className="h-[460px] w-[200vw] md:w-full">
              {/* ZoomableChart is typed for line charts; this mixed chart declares
                  its bar datasets explicitly, so the cast is safe at runtime. */}
              <ZoomableChart
                data={data as unknown as ChartData<"line">}
                options={options as unknown as ChartOptions<"line">}
              />
            </div>
          </div>
          <p className="px-1 pt-1 text-[11px] leading-relaxed text-muted">
            Cloud = return density • dots = sampled outcomes • ticks bottom→top = P10 / P25 / P50 / P75 / P90
            (P50 is longest)
          </p>
        </div>
      )}
    </Card>
  );
}

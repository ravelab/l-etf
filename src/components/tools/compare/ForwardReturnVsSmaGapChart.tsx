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
import type { EtfConfig, PricePoint, RatePoint } from "@/lib/simulation/types";
import { simulateWithWarmUp } from "@/lib/simulation/engine";
import {
  buildForwardSmaReturnPoints,
  type ForwardSmaReturnPoint,
} from "@/lib/simulation/forward-sma-returns";
import {
  buildLogRaincloudDensity,
  sampleRaincloudItems,
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

const BIN_WIDTH_PCT = 2; // x-axis bin width: 2 percentage points of gap
// Bins clipped to [-26%, +26%] so the edge buckets read "≤-24%" / "≥24%";
// any values past ±26% fold into those edge buckets.
const BIN_MIN_PCT = -26;
const BIN_MAX_PCT = 26;

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

function bucketize(points: ForwardSmaReturnPoint[]): ForwardSmaReturnPoint[][] {
  const binCount = Math.round((BIN_MAX_PCT - BIN_MIN_PCT) / BIN_WIDTH_PCT);
  const buckets: ForwardSmaReturnPoint[][] = Array.from({ length: binCount }, () => []);
  for (const p of points) {
    if (!Number.isFinite(p.realReturnFactor) || p.realReturnFactor <= 0) continue;
    buckets[binIndexForGap(p.gap)].push(p);
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
  uproConfig: EtfConfig;
  tqqqConfig: EtfConfig;
  spxRiskOffValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  spxRiskOffOpenValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  ndxRiskOffValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  ndxRiskOffOpenValues: Partial<Record<EtfConfig["riskOffAsset"], number[]>>;
  startDateSp: string;
  startDateNq: string;
  endDate: string;
}

// Invisible bars provide grouped x-positions and tooltip hit regions; the
// plugins render the raincloud and percentile marks themselves.
interface RainDotPoint {
  date: string;
  value: number;
}

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
  rainPoints: Array<RainDotPoint[]>;
  cloudColor: string;
  rainColor: string;
  raincloudSide: -1 | 1;
};

type RaincloudDatasetFields = Pick<
  RaincloudDataset,
  | "percentileStats"
  | "percentileColor"
  | "cloudProfiles"
  | "rainPoints"
  | "cloudColor"
  | "rainColor"
  | "raincloudSide"
>;

function getRainDotGeometry(
  bar: { x: number; width: number },
  raincloudSide: -1 | 1,
  datasetIndex: number,
  pointIndex: number,
) {
  const halfWidth = Math.max(2, bar.width / 2);
  const jitter = (pointIndex * 0.61803398875 + datasetIndex * 0.271828) % 1;
  return {
    x: bar.x - raincloudSide * halfWidth * (0.72 + jitter * 0.72),
    radius: Math.min(1.6, Math.max(1.05, halfWidth * 0.24)),
  };
}

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
      if (!fields.rainPoints || !fields.raincloudSide || !fields.rainColor) return;
      const meta = chart.getDatasetMeta(datasetIndex);

      meta.data.forEach((element, index) => {
        const points = fields.rainPoints?.[index] ?? [];
        if (points.length === 0) return;
        const bar = element as unknown as { x: number; width: number };

        points.forEach((point, pointIndex) => {
          const y = yScale.getPixelForValue(point.value);
          if (y < chartArea.top || y > chartArea.bottom) return;
          // Golden-ratio spacing gives stable, non-banding jitter without
          // random movement every time Chart.js redraws on hover.
          const { x, radius } = getRainDotGeometry(
            bar,
            fields.raincloudSide!,
            datasetIndex,
            pointIndex,
          );
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
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

interface RainDotHover {
  datasetIndex: number;
  bucketIndex: number;
  pointIndex: number;
  point: RainDotPoint;
  x: number;
  y: number;
  color: string;
  label: string;
}

const rainDotHoverByChart = new WeakMap<object, RainDotHover>();

function findRainDotAt(chart: ChartJS<"bar">, pointerX: number, pointerY: number): RainDotHover | null {
  const yScale = chart.scales.y;
  if (!yScale) return null;

  const hitRadius = 7;
  let nearest: (RainDotHover & { distanceSquared: number }) | null = null;

  chart.data.datasets.forEach((dataset, datasetIndex) => {
    if (!chart.isDatasetVisible(datasetIndex)) return;
    const fields = dataset as unknown as Partial<RaincloudDatasetFields>;
    if (!fields.rainPoints || !fields.raincloudSide || !fields.rainColor) return;
    const meta = chart.getDatasetMeta(datasetIndex);

    meta.data.forEach((element, bucketIndex) => {
      const points = fields.rainPoints?.[bucketIndex] ?? [];
      const bar = element as unknown as { x: number; width: number };
      points.forEach((point, pointIndex) => {
        const { x } = getRainDotGeometry(bar, fields.raincloudSide!, datasetIndex, pointIndex);
        const y = yScale.getPixelForValue(point.value);
        const distanceSquared = (pointerX - x) ** 2 + (pointerY - y) ** 2;
        if (distanceSquared > hitRadius ** 2 || (nearest && distanceSquared >= nearest.distanceSquared)) return;
        nearest = {
          datasetIndex,
          bucketIndex,
          pointIndex,
          point,
          x,
          y,
          color: fields.rainColor!,
          label: String(dataset.label ?? "").split(" — ")[0],
          distanceSquared,
        };
      });
    });
  });

  const hit = nearest as (RainDotHover & { distanceSquared: number }) | null;
  if (!hit) return null;
  return {
    datasetIndex: hit.datasetIndex,
    bucketIndex: hit.bucketIndex,
    pointIndex: hit.pointIndex,
    point: hit.point,
    x: hit.x,
    y: hit.y,
    color: hit.color,
    label: hit.label,
  };
}

const rainDotTooltipPlugin: Plugin<"bar"> = {
  id: "raincloudDotTooltip",
  afterEvent(chart, args) {
    const eventX = args.event.x;
    const eventY = args.event.y;
    const next =
      args.event.type === "mouseout" || eventX == null || eventY == null
        ? null
        : findRainDotAt(chart, eventX, eventY);
    const previous = rainDotHoverByChart.get(chart);
    if (!next && !previous) return;

    if (next) {
      rainDotHoverByChart.set(chart, next);
      chart.canvas.dataset.rainDotTooltip = `${next.label}|${next.point.date}|${factorToPctLabel(next.point.value)}`;
      chart.canvas.style.cursor = "help";
      const tooltip = chart.tooltip as unknown as {
        setActiveElements?: (
          elements: Array<{ datasetIndex: number; index: number }>,
          position: { x: number; y: number },
        ) => void;
      };
      const activateDotTooltip = () =>
        tooltip?.setActiveElements?.(
          [{ datasetIndex: next.datasetIndex, index: next.bucketIndex }],
          { x: eventX!, y: eventY! },
        );
      activateDotTooltip();
      // Chart.js's built-in tooltip plugin may process the same mousemove
      // after this plugin and restore the bucket summary. Reassert the dot
      // target once that event cycle finishes, then redraw without animation.
      queueMicrotask(() => {
        if (rainDotHoverByChart.get(chart) !== next || !chart.canvas.isConnected) return;
        activateDotTooltip();
        chart.draw();
      });
    } else {
      rainDotHoverByChart.delete(chart);
      delete chart.canvas.dataset.rainDotTooltip;
      chart.canvas.style.cursor = "";
      if (previous) {
        const tooltip = chart.tooltip as unknown as {
          setActiveElements?: (elements: never[], position: { x: number; y: number }) => void;
        };
        tooltip?.setActiveElements?.([], { x: eventX ?? 0, y: eventY ?? 0 });
      }
    }
    args.changed = true;
  },
  afterDatasetsDraw(chart) {
    const hover = rainDotHoverByChart.get(chart);
    if (hover) {
      const { ctx } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, 4.5, 0, Math.PI * 2);
      ctx.strokeStyle = hover.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
  },
  afterDestroy(chart) {
    rainDotHoverByChart.delete(chart);
  },
};

ChartJS.register(raincloudPlugin, percentileMarkersPlugin, rainDotTooltipPlugin);

export function ForwardReturnVsSmaGapChart({
  spxPrices,
  ndxPrices,
  rates,
  monthlyCpi,
  uproConfig,
  tqqqConfig,
  spxRiskOffValues,
  spxRiskOffOpenValues,
  ndxRiskOffValues,
  ndxRiskOffOpenValues,
  startDateSp,
  startDateNq,
  endDate,
}: ForwardReturnVsSmaGapChartProps) {
  const colors = getChartThemeColors();

  const uproResult = useMemo(
    () => simulateWithWarmUp(
      spxPrices,
      rates,
      [uproConfig],
      startDateSp,
      1000,
      {
        riskOffValuesByAsset: spxRiskOffValues,
        riskOffOpenValuesByAsset: spxRiskOffOpenValues,
        endDate,
      },
    ).etfResults.find((result) => result.id === `${uproConfig.id}-sma`) ?? null,
    [spxPrices, rates, uproConfig, startDateSp, spxRiskOffValues, spxRiskOffOpenValues, endDate],
  );
  const tqqqResult = useMemo(
    () => ndxPrices.length >= 2
      ? simulateWithWarmUp(
          ndxPrices,
          rates,
          [tqqqConfig],
          startDateNq,
          1000,
          {
            riskOffValuesByAsset: ndxRiskOffValues,
            riskOffOpenValuesByAsset: ndxRiskOffOpenValues,
            endDate,
          },
        ).etfResults.find((result) => result.id === `${tqqqConfig.id}-sma`) ?? null
      : null,
    [ndxPrices, rates, tqqqConfig, startDateNq, ndxRiskOffValues, ndxRiskOffOpenValues, endDate],
  );

  const uproPoints = useMemo(
    () =>
      buildForwardSmaReturnPoints({
        indexPrices: spxPrices,
        strategyResult: uproResult,
        config: uproConfig,
        monthlyCpi,
        startDate: startDateSp,
        endDate,
      }),
    [spxPrices, uproResult, uproConfig, monthlyCpi, startDateSp, endDate],
  );
  const tqqqPoints = useMemo(
    () =>
      buildForwardSmaReturnPoints({
        indexPrices: ndxPrices,
        strategyResult: tqqqResult,
        config: tqqqConfig,
        monthlyCpi,
        startDate: startDateNq,
        endDate,
      }),
    [ndxPrices, tqqqResult, tqqqConfig, monthlyCpi, startDateNq, endDate],
  );

  const uproBuckets = useMemo(() => bucketize(uproPoints), [uproPoints]);
  const tqqqBuckets = useMemo(() => bucketize(tqqqPoints), [tqqqPoints]);

  const binCount = Math.round((BIN_MAX_PCT - BIN_MIN_PCT) / BIN_WIDTH_PCT);
  const labels = useMemo(
    () => Array.from({ length: binCount }, (_, i) => binLabel(i)),
    [binCount],
  );

  const uproStats = useMemo(
    () => uproBuckets.map((bucket) => summarize(bucket.map((point) => point.realReturnFactor))),
    [uproBuckets],
  );
  const tqqqStats = useMemo(
    () => tqqqBuckets.map((bucket) => summarize(bucket.map((point) => point.realReturnFactor))),
    [tqqqBuckets],
  );

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
      label: `UPRO SMA — SMA(${uproConfig.smaPeriod})`,
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
        return stats
          ? buildLogRaincloudDensity(
              bucket.map((point) => point.realReturnFactor),
              stats.min,
              stats.max,
            )
          : [];
      }),
      rainPoints: uproBuckets.map((bucket) =>
        sampleRaincloudItems(bucket, (point) => point.realReturnFactor).map((point) => ({
          date: point.date,
          value: point.realReturnFactor,
        })),
      ),
      cloudColor: "rgba(59, 130, 246, 0.38)",
      rainColor: "rgba(59, 130, 246, 0.7)",
      raincloudSide: -1,
    };
    const tqqqDataset: RaincloudDataset = {
      type: "bar",
      label: `TQQQ SMA — SMA(${tqqqConfig.smaPeriod})`,
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
        return stats
          ? buildLogRaincloudDensity(
              bucket.map((point) => point.realReturnFactor),
              stats.min,
              stats.max,
            )
          : [];
      }),
      rainPoints: tqqqBuckets.map((bucket) =>
        sampleRaincloudItems(bucket, (point) => point.realReturnFactor).map((point) => ({
          date: point.date,
          value: point.realReturnFactor,
        })),
      ),
      cloudColor: "rgba(249, 115, 22, 0.38)",
      rainColor: "rgba(249, 115, 22, 0.7)",
      raincloudSide: 1,
    };
    const uproMedianLine = {
      type: "line" as const,
      label: "UPRO SMA median",
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
      label: "TQQQ SMA median",
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
      label: "UPRO SMA n/total",
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
      label: "TQQQ SMA n/total",
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
  }, [labels, uproBuckets, uproStats, tqqqBuckets, tqqqStats, uproConfig.smaPeriod, tqqqConfig.smaPeriod]);

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
              return ChartJS.defaults.plugins.legend.labels
                .generateLabels(chart)
                .filter((item) => {
                  if (item.datasetIndex == null) return false;
                  const dataset = chart.data.datasets[item.datasetIndex] as unknown as Partial<RaincloudDatasetFields>;
                  return dataset.cloudColor !== undefined;
                })
                .map((item) => {
                  const dataset = chart.data.datasets[item.datasetIndex!] as unknown as Partial<RaincloudDatasetFields>;
                  return {
                    ...item,
                    text: item.text.split(" — ")[0],
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
            const hover = rainDotHoverByChart.get(item.chart);
            if (hover) {
              return item.datasetIndex === hover.datasetIndex && item.dataIndex === hover.bucketIndex;
            }
            const ds = item.dataset as unknown as {
              percentileStats?: Array<PercentileStats | null>;
            };
            return ds.percentileStats !== undefined;
          },
          callbacks: {
            title(items: TooltipItem<"bar">[]) {
              return items.some((item) => rainDotHoverByChart.has(item.chart)) ? "" : items[0]?.label ?? "";
            },
            label(item: TooltipItem<"bar">) {
              const hover = rainDotHoverByChart.get(item.chart);
              if (
                hover &&
                item.datasetIndex === hover.datasetIndex &&
                item.dataIndex === hover.bucketIndex
              ) {
                return [
                  hover.label,
                  `Start: ${hover.point.date.replace(/-/g, "/")}`,
                  `1-year real return: ${factorToPctLabel(hover.point.value)}`,
                ];
              }
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
          {totalUpro} UPRO SMA • {totalTqqq} TQQQ SMA
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
            SMA strategy returns include risk-off periods • cloud = return density • dots = sampled outcomes (hover for
            start date) • ticks bottom→top = P10 / P25 / P50 / P75 / P90 (P50 is longest)
          </p>
        </div>
      )}
    </Card>
  );
}

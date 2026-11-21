"use client";

import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import type { ChartData, ChartOptions } from "chart.js";
import { ensureChartJSRegistered } from "@/components/ui/ChartJSInitializer";
import { getChartThemeColors } from "@/lib/chart-options";
import { useIsDarkTheme } from "@/lib/hooks/use-is-dark-theme";
import {
  buildHistoryRelevance, HISTORY_RELEVANCE_WEIGHTS, type HistoryRelevanceIndex, type HistoryRelevancePoint,
} from "@/lib/simulation/history-relevance";
import { LETF_FUND_RESULT_ID } from "@/lib/simulation/letf-dual-sleeve";
import type { EtfResult } from "@/lib/simulation/types";

const LINES = [
  { key: "composite", label: "Composite", light: "#0f172a", dark: "#f1f5f9", dash: [] },
  { key: "realCagr", label: "Real CAGR", light: "#0e7490", dark: "#22d3ee", dash: [] },
  { key: "volatility", label: "Volatility", light: "#6d28d9", dark: "#c4b5fd", dash: [6, 3] },
] as const;

type Factor = Exclude<typeof LINES[number]["key"], "composite">;
const ETF_BY_INDEX = { sp500: "UPRO (3× SPX)", nasdaq100: "TQQQ (3× NDX)", combo: "TQQQ / UPRO" } as const;
const SMA_VOL_NAMES = { sp500: "UPRO (SMA Vol RSI,", nasdaq100: "TQQQ (SMA Vol RSI," } as const;
type MonthlyCpi = { date: string; value: number }[];

function getStrategyIndex(path: EtfResult): HistoryRelevanceIndex | null {
  if (path.id === LETF_FUND_RESULT_ID) {
    return path.name.startsWith("TQQQ/UPRO (SMA Vol RSI,") ? "combo" : null;
  }
  return path.id.endsWith("-sma") && path.name.startsWith(SMA_VOL_NAMES[path.sourceIndex])
    ? path.sourceIndex
    : null;
}

const yearsApart = (lag: number) => `${lag} ${lag === 1 ? "year" : "years"}`;
const relevanceText = (value: number | null) => value === null ? "—" : value.toFixed(2);
function pairCount(point: HistoryRelevancePoint) {
  return point.minPairs === point.maxPairs ? String(point.maxPairs) : `${point.minPairs}–${point.maxPairs}`;
}

export function HistoryRelevanceChart({ path, monthlyCpi }: { path: EtfResult; monthlyCpi: MonthlyCpi }) {
  const index = getStrategyIndex(path);
  return index ? <HistoryRelevancePanel index={index} path={path} monthlyCpi={monthlyCpi} /> : null;
}

function HistoryRelevancePanel({ index, path, monthlyCpi }: {
  index: HistoryRelevanceIndex;
  path: EtfResult;
  monthlyCpi: MonthlyCpi;
}) {
  const [lag, setLag] = useState(1);
  const isDark = useIsDarkTheme();
  useEffect(() => { ensureChartJSRegistered(); }, []);
  const series = useMemo(() => buildHistoryRelevance(path, monthlyCpi, index), [path, monthlyCpi, index]);
  const points = series?.points;
  const maxLag = (points?.length ?? 1) - 1;
  const inspected = points?.[Math.min(lag, maxLag)];

  const chartData = useMemo<ChartData<"line">>(() => ({
    labels: points?.map(point => point.lag),
    datasets: LINES.map(line => ({
      label: line.label,
      data: points?.map(point => point[line.key]) ?? [],
      borderColor: isDark ? line.dark : line.light,
      backgroundColor: isDark ? line.dark : line.light,
      borderWidth: line.key === "composite" ? 2 : 1.5,
      borderDash: [...line.dash],
      pointRadius: 0,
      pointHoverRadius: 4,
      order: line.key === "composite" ? 1 : 0,
    })),
  }), [isDark, points]);

  const colors = getChartThemeColors();
  const options: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: {
        title: { display: true, text: "Years apart", color: colors.axisTitleText },
        ticks: { color: colors.tickText, maxTicksLimit: 7 },
        grid: { display: false },
      },
      y: {
        min: -1, max: 1,
        title: { display: true, text: "Correlation", color: colors.axisTitleText },
        ticks: { color: colors.tickText, stepSize: 0.5 },
        grid: { color: context => context.tick.value === 0 ? colors.emphasisGrid : colors.grid },
      },
    },
    plugins: {
      legend: {
        labels: {
          color: colors.legendText,
          usePointStyle: true,
          pointStyle: "line",
          sort: (a, b) => (a.datasetIndex ?? 0) - (b.datasetIndex ?? 0),
        },
      },
      tooltip: {
        callbacks: {
          title: items => `${yearsApart(Number(items[0]?.label))} apart`,
          label: item => `${item.dataset.label}: ${relevanceText(item.parsed.y)}`,
          footer: items => {
            const point = points?.[items[0]?.dataIndex];
            return point ? `${pairCount(point)} pairs per cutoff` : "";
          },
        },
      },
    },
  };

  const titleId = `history-relevance-${path.id}`;
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-card-border bg-card-bg p-4" aria-labelledby={titleId}>
      <h3 id={titleId} className="font-semibold">Historical Relevance</h3>
      {!series && <p role="status" className="text-sm text-muted">Historical relevance requires monthly CPI data.</p>}
      {series && inspected && (
        <>
          <div className="relative h-72 min-w-0 sm:h-80">
            <Line className="max-w-full" data={chartData} options={options} aria-label={`${ETF_BY_INDEX[index]} performance relevance by years apart`} />
          </div>
          <div className="space-y-2 border-t border-card-border pt-3 text-sm">
            <label className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="tabular-nums">Inspect lag · {yearsApart(inspected.lag)}</span>
              <input
                id={`${titleId}-lag`}
                type="range"
                className="min-h-11 min-w-32 flex-1"
                min={0}
                max={maxLag}
                value={inspected.lag}
                aria-label="Inspect years apart"
                onChange={event => setLag(event.target.valueAsNumber)}
              />
            </label>
            <div aria-live="polite" className="space-y-1">
              <p className="text-muted">
                {pairCount(inspected)} pairs per cutoff
                {inspected.olderSources.length > 0 && ` · Earlier windows: ${inspected.olderSources.join(", ")}`}
                {inspected.maxPairs < 3 && " · Too few pairs to estimate relevance"}
                {inspected.lag === 0 && " · Each window compared with itself"}
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                {LINES.map(line => (
                  <div key={line.key} className="flex gap-1.5">
                    <dt className="text-muted">{line.label}</dt>
                    <dd className={line.key === "composite" ? "font-semibold" : undefined}>{relevanceText(inspected[line.key])}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            SMA Vol RSI · {series.startDate} to {series.throughDate}.
          </p>
          <p className="text-xs text-muted">
            Composite weights: {LINES.slice(1).map(line =>
              `${line.label} ${Math.round(HISTORY_RELEVANCE_WEIGHTS[line.key as Factor] * 100)}%`
            ).join(" · ")}.
          </p>
          <p className="text-xs leading-relaxed text-muted">
            Volatility measures daily return dispersion within each year.
            Negative values show inverse relationships. Estimates use the median across four annual cutoffs
            with at least three pairs per cutoff.
          </p>
        </>
      )}
    </section>
  );
}

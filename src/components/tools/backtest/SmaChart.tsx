"use client";

import { useEffect, useMemo, useState } from "react";
import { useMaxPageButtons } from "@/lib/hooks/use-max-page-buttons";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import type { BacktestResult, EtfConfig, PricePoint } from "@/lib/simulation/types";
import { formatDate } from "@/lib/format";
import {
  getVisibleIndexBounds,
  pickLineChartIndices,
  selectSampledIndices,
  type VisibleRange,
} from "@/lib/chart-resampling";
import { buildSmaTradeRows, formatSignedNumber, type SmaTradeRow } from "@/lib/sma-trade-rows";
import {
  getDaysTillNextEvent,
  getRiskOffAdvantage,
  getRiskOffRealCagr,
  getRiskOnRealCagr,
  type SmaSegmentContext,
} from "@/lib/sma-trade-metrics";

const MAX_VISIBLE_POINTS = 1400;

interface SmaChartProps {
  result: BacktestResult;
  etfIndex: number;
  etfDates: string[];
  closePrices: number[];
  adjustedClosePrices: number[];
  openPrices: number[];
  tradeClosePrices: number[];
  tradeOpenPrices: number[];
  syntheticPriceScale: number;
  etfConfigs: EtfConfig[];
  annualizedInflation: number;
  riskOffPricesByTicker?: Record<string, PricePoint[]>;
}

export function SmaChart({ result, etfIndex, etfDates, closePrices, adjustedClosePrices, openPrices, tradeClosePrices, tradeOpenPrices, syntheticPriceScale, etfConfigs, annualizedInflation, riskOffPricesByTicker }: SmaChartProps) {
  const etf = result.etfResults[etfIndex];
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const [isDarkTheme, setIsDarkTheme] = useState(true);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const syncTheme = () => setIsDarkTheme(root.classList.contains("dark"));
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const baseConfig = useMemo(() => {
    if (!etf) return null;
    const base = stripVariantSuffix(etf.id);
    return etfConfigs.find((cfg) => cfg.id === base) ?? null;
  }, [etf, etfConfigs]);
  const dateToIndex = useMemo(
    () => new Map(etfDates.map((date, idx) => [date, idx])),
    [etfDates]
  );
  const indexPriceLabel = baseConfig?.smaIndex === "nasdaq100" ? "QQQ" : "VOO";
  const etfPriceLabel = baseConfig?.name ?? "ETF";
  const priceDatasetLabel = `${indexPriceLabel} Price`;
  const smaDatasetLabel = `${indexPriceLabel} SMA`;
  const closeNormalizationFactor = useMemo(() => {
    for (let i = closePrices.length - 1; i >= 0; i--) {
      const close = closePrices[i];
      const adjusted = adjustedClosePrices[i];
      const rawClose = Number.isFinite(close) && syntheticPriceScale > 0 ? close / syntheticPriceScale : close;
      const rawAdjusted =
        Number.isFinite(adjusted) && syntheticPriceScale > 0
          ? adjusted / syntheticPriceScale
          : adjusted;
      if (
        Number.isFinite(rawClose) &&
        Number.isFinite(rawAdjusted) &&
        (rawClose as number) > 0 &&
        (rawAdjusted as number) > 0
      ) {
        return (rawAdjusted as number) / (rawClose as number);
      }
    }
    return 1;
  }, [adjustedClosePrices, closePrices, syntheticPriceScale]);
  const riskOffPct = useMemo(() => {
    if (!etf || etf.smaSignals.length === 0 || etfDates.length === 0) return null;
    const signals = [...etf.smaSignals].sort((a, b) => a.date.localeCompare(b.date));
    let riskOffDays = 0;
    let isRiskOn = etf.smaStartInvested ?? true;
    let prevIdx = 0;
    for (const signal of signals) {
      const idx = dateToIndex.get(signal.date);
      if (idx == null) continue;
      if (!isRiskOn) {
        riskOffDays += idx - prevIdx;
      }
      isRiskOn = signal.type === "buy";
      prevIdx = idx;
    }
    // Count remaining days after last signal
    if (!isRiskOn) {
      riskOffDays += etfDates.length - 1 - prevIdx;
    }
    const totalDays = etfDates.length - 1;
    if (totalDays <= 0) return null;
    return (riskOffDays / totalDays) * 100;
  }, [dateToIndex, etf, etfDates]);

  const tradeRows = useMemo(() => {
    if (!etf || !baseConfig) return [];
    return buildSmaTradeRows({
      etf,
      config: baseConfig,
      etfDates,
      closePrices,
      openPrices,
      tradeClosePrices,
      tradeOpenPrices,
      syntheticPriceScale,
      annualizedInflation,
    });
  }, [annualizedInflation, baseConfig, closePrices, etf, etfDates, openPrices, syntheticPriceScale, tradeClosePrices, tradeOpenPrices]);

  const fullData = useMemo(() => {
    if (!etf || !etf.smaPrices.length) {
      return { labels: [], datasets: [] };
    }

    // Build signal lookup maps for O(1) access instead of O(n) find per date
    const buySignals = new Map<string, number>();
    const sellSignals = new Map<string, number>();
    for (const s of etf.smaSignals) {
      if (s.type === "buy") buySignals.set(s.date, s.price);
      else if (s.type === "sell") sellSignals.set(s.date, s.price);
    }

    const dates = etfDates;
    const priceSeries = dates.map((_, i) => {
      const close = closePrices[i];
      if (!Number.isFinite(close) || !Number.isFinite(closeNormalizationFactor)) return close;
      const rawClose = syntheticPriceScale > 0 ? close / syntheticPriceScale : close;
      return rawClose * closeNormalizationFactor;
    });
    const smaSeries = dates.map((_, i) => {
      const v = etf.smaPrices[i];
      return isNaN(v) ? null : v * closeNormalizationFactor;
    });
    const buySeries = dates.map((date) => {
      const v = buySignals.get(date);
      return v == null ? null : v * closeNormalizationFactor;
    });
    const sellSeries = dates.map((date) => {
      const v = sellSignals.get(date);
      return v == null ? null : v * closeNormalizationFactor;
    });

    return {
      labels: dates,
      datasets: [
        {
          label: priceDatasetLabel,
          data: priceSeries,
          borderColor: isDarkTheme ? "#e5e7eb" : "#334155",
          borderWidth: isDarkTheme ? 0.6 : 1.1,
          pointRadius: 0,
        },
        {
          label: smaDatasetLabel,
          data: smaSeries,
          borderColor: isDarkTheme ? "#eab308" : "#a16207",
          borderWidth: isDarkTheme ? 1.2 : 1.6,
          pointRadius: 0,
          borderDash: [4, 2],
        },
        {
          label: "Buy",
          data: buySeries,
          borderColor: "#00FA9A",
          backgroundColor: "#00FA9A",
          pointRadius: 5,
          pointStyle: "triangle" as const,
          showLine: false,
        },
        {
          label: "Sell",
          data: sellSeries,
          borderColor: "#ef4444",
          backgroundColor: "#ef4444",
          pointRadius: 5,
          pointStyle: "triangle" as const,
          rotation: 180,
          showLine: false,
        },
      ],
    };
  }, [closeNormalizationFactor, etfDates, closePrices, etf, priceDatasetLabel, smaDatasetLabel, syntheticPriceScale, isDarkTheme]);

  const labelTimes = useMemo(
    () =>
      (fullData.labels ?? []).map((label) => new Date(String(label)).getTime()).filter(Number.isFinite),
    [fullData.labels]
  );

  const signalIndices = useMemo(() => {
    if (!etf) return [];
    const signalDates = new Set(etf.smaSignals.map((signal) => signal.date));
    return etfDates.reduce<number[]>((indices, date, idx) => {
      if (signalDates.has(date)) indices.push(idx);
      return indices;
    }, []);
  }, [etf, etfDates]);

  // Decimation compacts the series, so a point's index in `data` is NOT its
  // index in closePrices/smaPrices. Keep the mapping so tooltips can resolve
  // back to the source row instead of reading a wholly unrelated date.
  const { data, sourceIndices } = useMemo(() => {
    if (labelTimes.length === 0) return { data: fullData, sourceIndices: null };
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    const indices = selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS, signalIndices);
    return { data: pickLineChartIndices(fullData, indices), sourceIndices: indices };
  }, [fullData, labelTimes, signalIndices, visibleRange]);

  const resetKey = useMemo(() => {
    const first = etfDates[0] ?? "";
    const last = etfDates[etfDates.length - 1] ?? "";
    return `${etf?.id ?? "etf"}|${first}|${last}|${etf?.smaSignals.length ?? 0}`;
  }, [etf, etfDates]);

  const options = useMemo(
    () => {
      const chartColors = getChartThemeColors();
      const legendHoverIsolation = createLegendHoverIsolation();
      return ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index" as const, intersect: false },
      plugins: {
        legend: {
          position: "top" as const,
          labels: { color: chartColors.legendText, usePointStyle: true, font: { size: 11 } },
          ...legendHoverIsolation,
        },
        tooltip: {
          backgroundColor: chartColors.tooltipBackground,
          borderColor: chartColors.tooltipBorder,
          borderWidth: 1,
          titleColor: chartColors.tooltipTitle,
          bodyColor: chartColors.tooltipBody,
          usePointStyle: true,
          filter: (item: { dataset: { label?: string } }) => {
            // Hide SMA row from tooltip (only show Price and Buy/Sell signals)
            return item.dataset.label !== smaDatasetLabel;
          },
          callbacks: {
            label: (context: { dataset: { label?: string }; parsed: { y: number | null }; dataIndex: number }) => {
              const label = context.dataset.label || '';
              const value = context.parsed.y;

              if (value === null || value === undefined) return undefined;

              // For Price dataset, show difference from SMA percentage
              if (label === priceDatasetLabel) {
                const srcIdx = sourceIndices ? sourceIndices[context.dataIndex] : context.dataIndex;
                const priceClose = closePrices[srcIdx];
                const priceValue =
                  Number.isFinite(priceClose) && syntheticPriceScale > 0
                    ? (priceClose / syntheticPriceScale) * closeNormalizationFactor
                    : priceClose;
                const rawSma = etf?.smaPrices[srcIdx];
                const smaValue = rawSma == null ? undefined : rawSma * closeNormalizationFactor;

                if (priceValue != null && smaValue != null && isFinite(smaValue) && smaValue !== 0) {
                  const diffPercent = ((priceValue - smaValue) / smaValue) * 100;
                  const sign = diffPercent >= 0 ? '+' : '';
                  return `${sign}${diffPercent.toFixed(2)}%`;
                }
              }

              // For Buy/Sell signals, show the price
              return `${value.toLocaleString()}`;
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labelColor: (context: any) => {
              const label = context.dataset.label || '';
              const value = context.parsed.y;
              const dataIndex = context.dataIndex;

              // For Price dataset, color based on SMA difference
              if (label === priceDatasetLabel && value != null && dataIndex != null) {
                const srcIdx = sourceIndices ? sourceIndices[dataIndex] : dataIndex;
                const priceClose = closePrices[srcIdx];
                const priceValue =
                  Number.isFinite(priceClose) && syntheticPriceScale > 0
                    ? (priceClose / syntheticPriceScale) * closeNormalizationFactor
                    : priceClose;
                const rawSma = etf?.smaPrices[srcIdx];
                const smaValue = rawSma == null ? undefined : rawSma * closeNormalizationFactor;

                if (priceValue != null && smaValue != null && isFinite(smaValue) && smaValue !== 0) {
                  const diffPercent = ((priceValue - smaValue) / smaValue) * 100;
                  return {
                    borderColor: diffPercent >= 0 ? '#00FA9A' : '#ef4444',
                    backgroundColor: diffPercent >= 0 ? '#00FA9A' : '#ef4444',
                  };
                }
              }

              // Default colors for other datasets
              return {
                borderColor: context.dataset.borderColor || '#9ca3af',
                backgroundColor: context.dataset.backgroundColor || context.dataset.borderColor || '#9ca3af',
              };
            },
          },
        },
      },
      scales: {
        x: {
          type: "time" as const,
          time: { unit: "year" as const, tooltipFormat: "yyyy/MM/dd" },
          grid: { color: chartColors.grid },
          ticks: { color: chartColors.tickText, maxTicksLimit: 12 },
        },
        y: {
          type: "logarithmic" as const,
          grid: { color: chartColors.grid },
          ticks: { color: chartColors.tickText },
        },
      },
    })},
    [closeNormalizationFactor, closePrices, etf, priceDatasetLabel, smaDatasetLabel, sourceIndices, syntheticPriceScale]
  );

  if (!etf || !etf.smaPrices.length) return null;

  return (
    <div>
      <h3 className="text-sm font-medium text-muted mb-3">
        SMA Strategy — {etf.name}
      </h3>
      <div className="h-[300px]">
        <ZoomableChart
          data={data}
          options={options}
          onRangeChange={setVisibleRange}
          resetKey={resetKey}
        />
      </div>
      <div className="mt-4">
        <h4 className="text-sm font-medium text-muted mb-2">
          {tradeRows.length} Trade Days
          {riskOffPct !== null && (
            <span className="ml-2 text-xs text-muted">({riskOffPct.toFixed(1)}% risk-off)</span>
          )}
        </h4>
        {tradeRows.length === 0 ? (
          <p className="text-xs text-muted">No trades triggered for this SMA run.</p>
        ) : (
          <TradingDaysTable
            tradeRows={tradeRows}
            etfPriceLabel={etfPriceLabel}
            riskOffPricesByTicker={riskOffPricesByTicker}
            annualizedInflation={annualizedInflation}
            endDate={etfDates[etfDates.length - 1]}
            finalEtfPrice={tradeClosePrices[tradeClosePrices.length - 1] ?? closePrices[closePrices.length - 1]}
          />
          )}
          </div>
          </div>
          );
          }

          const TRADES_PAGE_SIZE = 10;

          function TradingDaysTable({
          tradeRows,
          etfPriceLabel,
          riskOffPricesByTicker,
          annualizedInflation,
          endDate,
          finalEtfPrice,
          }: {
          tradeRows: SmaTradeRow[];
          etfPriceLabel: string;
          riskOffPricesByTicker?: Record<string, PricePoint[]>;
          annualizedInflation: number;
          endDate: string;
          finalEtfPrice: number;
          }) {
          const [page, setPage] = useState(0);
          const maxButtons = useMaxPageButtons();

          // Build date→price lookups per risk-off ticker
          const riskOffLookups = useMemo(() => {
          if (!riskOffPricesByTicker) return [];
          const tickers = Object.keys(riskOffPricesByTicker);
          return tickers.map((ticker) => {
          const map = new Map<string, number>();
          const points = riskOffPricesByTicker[ticker];
          if (points) {
          for (const p of points) {
          if (Number.isFinite(p.close)) map.set(p.date, p.close);
          }
          }
          return map;
          });
          }, [riskOffPricesByTicker]);

  const totalPages = Math.ceil(tradeRows.length / TRADES_PAGE_SIZE);
  const paged = tradeRows.slice(page * TRADES_PAGE_SIZE, (page + 1) * TRADES_PAGE_SIZE);
  const segmentCtx: SmaSegmentContext = {
    tradeRows,
    endDate,
    finalEtfPrice,
    annualizedInflation,
    riskOffLookups,
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border text-left text-muted">
            <th className="pb-2 pr-4 font-medium">Trigger Day</th>
            <th className="pb-2 pr-4 font-medium">Action ({etfPriceLabel} Inflation-Adjusted)</th>
            <th className="pb-2 pr-4 font-medium text-right">Risk-Off Real CAGR</th>
            <th className="pb-2 pr-4 font-medium text-right">Risk-Off / If Risk-On</th>
            <th className="pb-2 pr-4 font-medium text-right">Risk-On Real CAGR</th>
            <th className="pb-2 font-medium text-right">Till Next Event</th>
          </tr>
        </thead>
        <tbody>
          {paged.map((row, pageIndex) => {
            const absoluteIndex = page * TRADES_PAGE_SIZE + pageIndex;
            const isTerminal = row.isEndLiquidation === true;
            const daysTillNextEvent = getDaysTillNextEvent(segmentCtx, absoluteIndex);
            const riskOffReturn = isTerminal ? null : getRiskOffRealCagr(segmentCtx, absoluteIndex);
            const riskOffAdvantage = getRiskOffAdvantage(segmentCtx, absoluteIndex);
            const riskOnReturn = getRiskOnRealCagr(segmentCtx, absoluteIndex);
            return (
            <tr
              key={`${row.signalDate}-${row.action}-${isTerminal ? "liq" : row.isInitialEntry ? "init" : "sig"}`}
              className="border-b border-card-border/50"
            >
              <td className="py-2.5 pr-4">
                {formatDate(row.signalDate)}
                {row.triggerClose != null && (
                  <span className="text-muted text-xs block md:inline md:ml-1">
                    ({row.triggerClose.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    {row.triggerSmaPctDiff != null && (
                      <span className={row.triggerSmaPctDiff >= 0 ? "text-positive" : "text-negative"}>
                        {" "}{row.triggerSmaPctDiff >= 0 ? "+" : ""}{row.triggerSmaPctDiff.toFixed(1)}%
                      </span>
                    )})
                  </span>
                )}
              </td>
              <td className={`py-2.5 pr-4 ${row.actionToneClass}`}>{row.action}</td>
              <td className={`py-2.5 pr-4 text-right ${riskOffReturn == null ? "" : riskOffReturn >= 0 ? "text-positive" : "text-negative"}`}>
                {riskOffReturn == null ? "\u2014" : formatSignedNumber(riskOffReturn, "", "%")}
              </td>
              <td className={`py-2.5 pr-4 text-right ${riskOffAdvantage == null ? "" : riskOffAdvantage >= 1 ? "text-positive" : "text-negative"}`}>
                {riskOffAdvantage == null ? "\u2014" : `${riskOffAdvantage.toFixed(2)}X`}
              </td>
              <td className={`py-2.5 pr-4 text-right ${riskOnReturn == null ? "" : riskOnReturn >= 0 ? "text-positive" : "text-negative"}`}>
                {riskOnReturn == null ? "\u2014" : formatSignedNumber(riskOnReturn, "", "%")}
              </td>
              <td className="py-2.5 text-right">
                {daysTillNextEvent === null ? "\u2014" : `${(daysTillNextEvent / 365.25).toFixed(2)}y`}
              </td>
            </tr>
          )})}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-muted">
          <span>
            {page * TRADES_PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * TRADES_PAGE_SIZE, tradeRows.length)} of {tradeRows.length}
          </span>
          <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            {(() => {
              const pages = [];
              if (totalPages <= maxButtons) {
                for (let i = 0; i < totalPages; i++) {
                  pages.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => setPage(i)}
                      className={`rounded px-2 py-1 ${page === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
                    >
                      {i + 1}
                    </button>
                  );
                }
              } else {
                const range = 2;
                const start = Math.max(0, page - range);
                const end = Math.min(totalPages - 1, page + range);

                if (start > 0) {
                  pages.push(
                    <button key={0} type="button" onClick={() => setPage(0)} className="rounded px-2 py-1 hover:bg-card-border/30">
                      1
                    </button>
                  );
                  if (start > 1) pages.push(<span key="start-dots" className="px-1">...</span>);
                }

                for (let i = start; i <= end; i++) {
                  pages.push(
                    <button
                      key={i}
                      type="button"
                      onClick={() => setPage(i)}
                      className={`rounded px-2 py-1 ${page === i ? "bg-accent text-accent-contrast" : "hover:bg-card-border/30"}`}
                    >
                      {i + 1}
                    </button>
                  );
                }

                if (end < totalPages - 1) {
                  if (end < totalPages - 2) pages.push(<span key="end-dots" className="px-1">...</span>);
                  pages.push(
                    <button key={totalPages - 1} type="button" onClick={() => setPage(totalPages - 1)} className="rounded px-2 py-1 hover:bg-card-border/30">
                      {totalPages}
                    </button>
                  );
                }
              }
              return pages;
            })()}
            <button
              type="button"
              disabled={page === totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded px-2 py-1 hover:bg-card-border/30 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function stripVariantSuffix(id: string): string {
  if (id.endsWith("-base")) return id.slice(0, -5);
  if (id.endsWith("-sma")) return id.slice(0, -4);
  return id;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useMaxPageButtons } from "@/lib/hooks/use-max-page-buttons";
import { ZoomableChart } from "@/components/ui/ZoomableChart";
import { createLegendHoverIsolation, getChartThemeColors } from "@/lib/chart-options";
import type { BacktestResult, EtfConfig, PricePoint } from "@/lib/simulation/types";
import { formatDate } from "@/lib/format";
import { DEFAULT_SMA_EXECUTION_MODE } from "@/lib/input-normalization";
import {
  getVisibleIndexBounds,
  pickLineChartIndices,
  selectSampledIndices,
  type VisibleRange,
} from "@/lib/chart-resampling";
import { formatRiskOffLiquidationAbbrev } from "@/lib/constants";

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
    let isRiskOn = true;
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
    const executionMode = baseConfig.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE;
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const anchorDate = etfDates[etfDates.length - 1] ?? null;

    const toAnchoredRealPrice = (price: number, date: string): number => {
      if (!Number.isFinite(price) || price <= 0) return price;
      if (!anchorDate || !Number.isFinite(annualizedInflation)) return price;
      const dateMs = new Date(`${date}T00:00:00Z`).getTime();
      const anchorMs = new Date(`${anchorDate}T00:00:00Z`).getTime();
      if (!Number.isFinite(dateMs) || !Number.isFinite(anchorMs)) return price;
      const yearsToAnchor = (anchorMs - dateMs) / msPerYear;
      const inflationFactor = Math.pow(1 + annualizedInflation, yearsToAnchor);
      if (!Number.isFinite(inflationFactor) || inflationFactor <= 0) return price;
      return price * inflationFactor;
    };

    const needsNextDay = executionMode === "next-day-open" || executionMode === "next-day-close";
    const lastIdx = etfDates.length - 1;
    const baseRows = etf.smaSignals.flatMap((signal) => {
      const signalIdx = dateToIndex.get(signal.date);
      // Hide signals whose next-day execution hasn't happened yet (no data beyond the signal day).
      if (needsNextDay && typeof signalIdx === "number" && signalIdx >= lastIdx) return [];
      const triggerClose = signalIdx != null ? closePrices[signalIdx] : undefined;
      const triggerSma = signalIdx != null ? etf.smaPrices[signalIdx] : undefined;
      const triggerSmaPctDiff =
        triggerClose != null && triggerSma != null && Number.isFinite(triggerClose) && Number.isFinite(triggerSma) && triggerSma !== 0
          ? ((triggerClose / syntheticPriceScale - triggerSma) / triggerSma) * 100
          : null;
      const executionIdx =
        typeof signalIdx === "number"
          ? needsNextDay
            ? signalIdx + 1
            : signalIdx
          : null;
      const tradingDay = executionIdx === null ? null : etfDates[executionIdx];
      const effectiveDate = tradingDay ?? signal.date;
      const closePriceAtExecution = executionIdx !== null ? (tradeClosePrices[executionIdx] ?? closePrices[executionIdx]) : undefined;
      const openPriceAtExecution = executionIdx !== null ? (tradeOpenPrices[executionIdx] ?? openPrices[executionIdx]) : undefined;
      const etfPrice = executionMode === "next-day-open"
        ? openPriceAtExecution ?? closePriceAtExecution ?? signal.price
        : closePriceAtExecution ?? signal.price;
      const anchoredPrice =
        Number.isFinite(etfPrice) && etfPrice > 0 && effectiveDate
          ? toAnchoredRealPrice(etfPrice, effectiveDate)
          : null;
      const displayPrice = anchoredPrice && Number.isFinite(anchoredPrice) && anchoredPrice > 0 ? anchoredPrice : null;
      const priceStr = displayPrice ? ` (${formatSignedNumber(displayPrice, "$")})` : "";
      const displayClose =
        triggerClose != null && Number.isFinite(triggerClose)
          ? triggerClose / syntheticPriceScale
          : null;
      if (signal.type === "buy") {
        return {
          signalDate: signal.date,
          tradingDay,
          signalType: signal.type,
          eventPrice: displayPrice,
          triggerClose: displayClose,
          triggerSmaPctDiff,
          actionToneClass: "text-positive",
          action: `Buy ${baseConfig.name}${priceStr}`,
        };
      }
      return {
        signalDate: signal.date,
        tradingDay,
        signalType: signal.type,
        eventPrice: displayPrice,
        triggerClose: displayClose,
        triggerSmaPctDiff,
        actionToneClass: "text-negative",
        action: `Sell ${baseConfig.name}${priceStr}`,
      };
    });

    if (baseRows.length === 0) return [];

    const lastDay = etfDates[lastIdx] ?? "";
    const closeAtLast = tradeClosePrices[lastIdx] ?? closePrices[lastIdx];
    const openAtLast = tradeOpenPrices[lastIdx] ?? openPrices[lastIdx];
    const etfPriceAtLiquidation =
      executionMode === "next-day-open" ? openAtLast ?? closeAtLast : closeAtLast;
    const anchoredLiquidation =
      Number.isFinite(etfPriceAtLiquidation) &&
      etfPriceAtLiquidation > 0 &&
      lastDay
        ? toAnchoredRealPrice(etfPriceAtLiquidation, lastDay)
        : null;
    const displayLiquidationPrice =
      anchoredLiquidation != null &&
      Number.isFinite(anchoredLiquidation) &&
      anchoredLiquidation > 0
        ? anchoredLiquidation
        : null;

    const sortedByExecution = [...baseRows].sort((a, b) => {
      const da = a.tradingDay ?? a.signalDate;
      const db = b.tradingDay ?? b.signalDate;
      return da.localeCompare(db);
    });
    const lastExecuted = sortedByExecution[sortedByExecution.length - 1];
    const endsRiskOn = lastExecuted?.signalType === "buy";

    const liqPriceStr = displayLiquidationPrice
      ? ` (${formatSignedNumber(displayLiquidationPrice, "$")})`
      : "";
    const liquidationLabel = endsRiskOn
      ? `LIQUIDATE ${baseConfig.name}${liqPriceStr}`
      : `LIQUIDATE ${formatRiskOffLiquidationAbbrev(baseConfig.riskOffAsset)}`;

    const terminalRow = {
      signalDate: lastDay,
      tradingDay: lastDay,
      signalType: "sell" as const,
      eventPrice: displayLiquidationPrice,
      triggerClose: null as number | null,
      triggerSmaPctDiff: null as number | null,
      actionToneClass: "text-negative",
      action: liquidationLabel,
      isEndLiquidation: true as const,
    };

    return [...baseRows, terminalRow];
  }, [annualizedInflation, baseConfig, closePrices, dateToIndex, etf, etfDates, openPrices, syntheticPriceScale, tradeClosePrices, tradeOpenPrices]);

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

  const data = useMemo(() => {
    if (labelTimes.length === 0) return fullData;
    const { startIndex, endIndex } = getVisibleIndexBounds(labelTimes, visibleRange);
    const indices = selectSampledIndices(startIndex, endIndex, MAX_VISIBLE_POINTS, signalIndices);
    return pickLineChartIndices(fullData, indices);
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
                const priceClose = closePrices[context.dataIndex];
                const priceValue =
                  Number.isFinite(priceClose) && syntheticPriceScale > 0
                    ? (priceClose / syntheticPriceScale) * closeNormalizationFactor
                    : priceClose;
                const rawSma = etf?.smaPrices[context.dataIndex];
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
                const priceClose = closePrices[dataIndex];
                const priceValue =
                  Number.isFinite(priceClose) && syntheticPriceScale > 0
                    ? (priceClose / syntheticPriceScale) * closeNormalizationFactor
                    : priceClose;
                const rawSma = etf?.smaPrices[dataIndex];
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
    [closeNormalizationFactor, closePrices, etf, priceDatasetLabel, smaDatasetLabel, syntheticPriceScale]
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
          tradeRows: Array<{
          signalDate: string;
          tradingDay: string | null;
          signalType: "buy" | "sell";
          action: string;
          eventPrice: number | null;
          triggerClose: number | null;
          triggerSmaPctDiff: number | null;
          actionToneClass: string;
          isEndLiquidation?: boolean;
          }>;
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
  const getDaysTillNextEvent = (index: number): number | null => {
    if (tradeRows[index]?.isEndLiquidation) return null;
    const current = tradeRows[index]?.tradingDay;
    const next = tradeRows[index + 1]?.tradingDay ?? endDate;
    if (!current || !next) return null;
    const currentMs = new Date(`${current}T00:00:00Z`).getTime();
    const nextMs = new Date(`${next}T00:00:00Z`).getTime();
    if (!Number.isFinite(currentMs) || !Number.isFinite(nextMs)) return null;
    return Math.max(0, Math.round((nextMs - currentMs) / 86400000));
  };
  const getRiskOffAdvantage = (index: number): number | null => {
    if (tradeRows[index]?.isEndLiquidation) return null;
    if (tradeRows[index]?.signalType !== "sell") return null;
    const riskOff = getRiskOffTotalRealReturn(index);
    const sellPrice = tradeRows[index]?.eventPrice;
    const buyPrice = tradeRows[index + 1]?.eventPrice ?? finalEtfPrice;
    const years = getYearsBetween(index);
    if (
      riskOff == null ||
      sellPrice == null || buyPrice == null ||
      !Number.isFinite(sellPrice) || !Number.isFinite(buyPrice) ||
      sellPrice <= 0 || buyPrice <= 0 ||
      years == null || years <= 0
    ) {
      return null;
    }
    const nominalRiskOnRatio = buyPrice / sellPrice;
    const inflationFactor = Math.pow(1 + annualizedInflation, years);
    const realRiskOnRatio = nominalRiskOnRatio / inflationFactor;
    if (realRiskOnRatio <= 0) return null;
    const realRiskOffRatio = 1 + riskOff / 100;
    // Multiplier: risk-off ending value / risk-on ending value, both real
    return realRiskOffRatio / realRiskOnRatio;
  };
  const getYearsBetween = (index: number): number | null => {
    const current = tradeRows[index]?.tradingDay;
    const next = tradeRows[index + 1]?.tradingDay ?? endDate;
    if (!current || !next) return null;
    const ms = new Date(`${next}T00:00:00Z`).getTime() - new Date(`${current}T00:00:00Z`).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms / (365.25 * 24 * 60 * 60 * 1000);
  };
  const getRiskOnCagr = (index: number): number | null => {
    if (tradeRows[index]?.isEndLiquidation) return null;
    const currentPrice = tradeRows[index]?.eventPrice;
    const nextPrice = tradeRows[index + 1]?.eventPrice ?? finalEtfPrice;
    if (
      currentPrice == null || nextPrice == null ||
      !Number.isFinite(currentPrice) || !Number.isFinite(nextPrice) ||
      currentPrice <= 0 || nextPrice <= 0
    ) return null;
    if (tradeRows[index]?.signalType !== "buy") return null;
    const years = getYearsBetween(index);
    if (!years || years <= 0) return null;
    const nominalRatio = nextPrice / currentPrice;
    const inflationFactor = Math.pow(1 + annualizedInflation, years);
    const realRatio = nominalRatio / inflationFactor;
    if (realRatio <= 0) return null;
    return (Math.pow(realRatio, 1 / years) - 1) * 100;
  };
  const getRiskOffTotalRealReturn = (index: number): number | null => {
    if (tradeRows[index]?.isEndLiquidation) return null;
    if (tradeRows[index]?.signalType !== "sell") return null;
    if (riskOffLookups.length === 0) return null;
    const sellDate = tradeRows[index]?.tradingDay;
    const buyDate = tradeRows[index + 1]?.tradingDay ?? endDate;
    if (!sellDate || !buyDate) return null;
    const years = getYearsBetween(index);
    if (!years || years <= 0) return null;
    // Each component bought at equal weight; compute each component's return then average
    let totalReturn = 0;
    let count = 0;
    for (const lookup of riskOffLookups) {
      const sellPrice = lookup.get(sellDate);
      const buyPrice = lookup.get(buyDate);
      if (sellPrice == null || buyPrice == null || sellPrice <= 0 || buyPrice <= 0) continue;
      totalReturn += buyPrice / sellPrice;
      count++;
    }
    if (count === 0) return null;
    const avgNominalReturn = totalReturn / count;
    // Convert nominal return to real using inflation over the period
    const inflationFactor = Math.pow(1 + annualizedInflation, years);
    return (avgNominalReturn / inflationFactor - 1) * 100;
  };
  const getRiskOffCagr = (index: number): number | null => {
    const totalReturn = getRiskOffTotalRealReturn(index);
    const years = getYearsBetween(index);
    if (totalReturn == null || years == null || years <= 0) return null;
    const ratio = 1 + totalReturn / 100;
    if (ratio <= 0) return null;
    return (Math.pow(ratio, 1 / years) - 1) * 100;
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
            const daysTillNextEvent = getDaysTillNextEvent(absoluteIndex);
            const riskOffReturn = isTerminal ? null : getRiskOffCagr(absoluteIndex);
            const riskOffAdvantage = getRiskOffAdvantage(absoluteIndex);
            const riskOnReturn = getRiskOnCagr(absoluteIndex);
            return (
            <tr
              key={`${row.signalDate}-${row.action}-${isTerminal ? "liq" : "sig"}`}
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

function formatSignedNumber(value: number, prefix = "", suffix = ""): string {
  const sign = value >= 0 ? "+" : "-";
  const abs = Math.abs(value);

  let formatted: string;
  if (abs >= 1) {
    formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (abs >= 0.01) {
    formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 4 });
  } else {
    formatted = abs.toLocaleString(undefined, { minimumSignificantDigits: 3, maximumSignificantDigits: 4 });
  }

  if (prefix === "$") {
    return `${prefix}${sign === "-" ? "-" : ""}${formatted}${suffix}`;
  }
  return `${sign}${formatted}${suffix}`;
}

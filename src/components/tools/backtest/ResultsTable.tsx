"use client";

import { memo, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { BacktestResult, EtfResult } from "@/lib/simulation/types";
import {
  calcCagr,
  calcMaxDrawdown,
  calcMonthlyExtremes,
  calcSharpeRatio,
} from "@/lib/simulation/metrics";
import { formatMultiple, formatPercent } from "@/lib/format";
import { SortButton } from "@/components/ui/SortButton";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import { annualizedInflationForRange, cpiIndexRatioEndOverStart } from "@/lib/inflation";
import { getSymbolSpread } from "@/lib/constants";
import { buildToolsUrl } from "@/lib/tools-route";
import { formatDateSpan } from "@/lib/utils";

function indexBuyAndHoldTradingCostPct(initialInvestment: number, finalValue: number, symbol: string): number {
  if (!Number.isFinite(initialInvestment) || initialInvestment <= 0) return 0;
  if (!Number.isFinite(finalValue) || finalValue <= 0) return 0;
  const spread = getSymbolSpread(symbol, false);
  if (spread <= 0) return 0;
  const ratio = finalValue / initialInvestment;
  const postExit = ratio * (1 - spread);
  if (postExit <= 0) return 0;
  return (spread * (1 + ratio) / postExit) * 100;
}

function buildIndexRowFromValues(dates: string[], values: number[], label: string, id: string): EtfResult {
  const initialInvestment = values[0] ?? 0;
  const finalValue = values[values.length - 1] ?? 0;
  const cagr = calcCagr(initialInvestment, finalValue, dates[0], dates[dates.length - 1]);
  const drawdown = calcMaxDrawdown(values, dates);
  const monthlyExtremes = calcMonthlyExtremes(values, dates);
  const sharpeRatio = calcSharpeRatio(values);

  return {
    id: `__index_${id}__`,
    name: label,
    sourceIndex: id as "sp500" | "nasdaq100",
    dates,
    dailyValues: values,
    finalValue,
    cagr,
    sharpeRatio,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
    smaSignals: [],
    smaPrices: [],
    totalTradingCostPct: indexBuyAndHoldTradingCostPct(initialInvestment, finalValue, label),
  };
}

function buildIndexRow(result: BacktestResult, indexLabel: string): EtfResult {
  const { dates, nonLeveragedValues } = result;
  const initialInvestment = nonLeveragedValues[0] ?? 0;
  const finalValue = nonLeveragedValues[nonLeveragedValues.length - 1] ?? 0;
  const cagr = calcCagr(initialInvestment, finalValue, dates[0], dates[dates.length - 1]);
  const drawdown = calcMaxDrawdown(nonLeveragedValues, dates);
  const monthlyExtremes = calcMonthlyExtremes(nonLeveragedValues, dates);
  const sharpeRatio = calcSharpeRatio(nonLeveragedValues);

  return {
    id: "__index__",
    name: indexLabel,
    sourceIndex: "sp500",
    dates,
    dailyValues: nonLeveragedValues,
    finalValue,
    cagr,
    sharpeRatio,
    maxDrawdownPct: drawdown.pct,
    maxDrawdownDollar: drawdown.dollar,
    maxDrawdownDates: drawdown.maxDrawdownDates,
    longestDrawdownDays: drawdown.longestDays,
    longestDrawdownDates: drawdown.longestDrawdownDates,
    bestMonth: monthlyExtremes.bestMonth,
    bestMonthDates: monthlyExtremes.bestMonthDates,
    worstMonth: monthlyExtremes.worstMonth,
    worstMonthDates: monthlyExtremes.worstMonthDates,
    smaSignals: [],
    smaPrices: [],
    totalTradingCostPct: indexBuyAndHoldTradingCostPct(initialInvestment, finalValue, indexLabel),
  };
}

/** Must match the color function in ValueChart so table dots align with chart lines. */
const getDistinctColor = (i: number) => `hsl(${(i * 47) % 360} 85% 55%)`;

function DateRangeLink({
  dates,
  href,
  label,
}: {
  dates?: { start: string; end: string };
  href: string | null;
  label?: string;
}) {
  if (!dates) return null;
  const text = label ?? formatDateSpan(dates);
  if (!href) {
    return <span className="text-[10px] text-muted block">{text}</span>;
  }
  return (
    <Link href={href} className="text-[10px] text-accent hover:underline block">
      {text}
    </Link>
  );
}

function formatMonthLinkLabel(dates?: { start: string; end: string }): string | undefined {
  return dates?.start.slice(0, 7).replace("-", "/");
}

type SortKey =
  | "name"
  | "startDate"
  | "finalValue"
  | "cagr"
  | "sharpeRatio"
  | "avgActualLeverage"
  | "maxLeverageDeltaPct"
  | "maxDrawdownPct"
  | "longestDrawdownDays"
  | "realCagr"
  | "inflationPct"
  | "bestMonth"
  | "worstMonth"
  | "totalTradingCostPct";

type ResultsTableVariant = "backtest" | "futures";

interface ResultsTableProps {
  result: BacktestResult;
  indexLabel: string;
  /** Annualized inflation as a decimal (e.g. 0.03 for 3%). Fallback when monthlyCpi is unavailable. */
  annualizedInflation: number;
  /** Monthly CPI series used to compute per-row annualized inflation over each asset's active window. */
  monthlyCpi?: Array<{ date: string; value: number }>;
  /** Additional underlying index series to show as rows (e.g. Nasdaq 100 when backtesting both SP500 and Nasdaq). */
  underlyingIndexSeries?: Array<{ index: string; label: string; dates: string[]; values: number[] }>;
  resultTableTestId?: string;
  metricLinkTab?: "backtest" | "futures";
  /** Mean actual leverage (multiple) on risk-on days with futures; futures tab only. */
  avgActualLeverageById?: Record<string, number>;
  maxLeverageDeltaById?: Record<string, number>;
  variant?: ResultsTableVariant;
}

function ResultsTableImpl({
  result,
  indexLabel,
  annualizedInflation: rawInflation,
  monthlyCpi,
  underlyingIndexSeries,
  resultTableTestId,
  metricLinkTab = "backtest",
  avgActualLeverageById,
  maxLeverageDeltaById,
  variant = "backtest",
}: ResultsTableProps) {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const searchParams = useSearchParams();

  const rowInflation = (r: EtfResult): { rate: number; factor: number } => {
    const rowStart = r.dates[0];
    const rowEnd = r.dates[r.dates.length - 1];
    if (!rowStart || !rowEnd) return { rate: rawInflation, factor: 1 };
    const rate = monthlyCpi && monthlyCpi.length >= 2
      ? annualizedInflationForRange(monthlyCpi, rowStart, rowEnd)
      : rawInflation;
    if (monthlyCpi && monthlyCpi.length >= 2) {
      return {
        rate,
        factor: cpiIndexRatioEndOverStart(monthlyCpi, rowStart, rowEnd),
      };
    }
    const years = (new Date(rowEnd).getTime() - new Date(rowStart).getTime()) / msPerYear;
    return { rate, factor: Math.pow(1 + rate, years) };
  };

  /** Denominator for “real” multiples: funded Amount on futures (matches transaction ledger), else first daily value. */
  const realValueInitialEquity = (r: EtfResult): number => {
    if (variant === "futures" && result.investedValues.length > 0) {
      const v = result.investedValues[0]!;
      if (Number.isFinite(v) && v > 0) return v;
    }
    return r.dailyValues[0] ?? 1;
  };

  const [sortKey, setSortKey] = useState<SortKey>("realCagr");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo(() => {
    const indexRows: EtfResult[] = [];
    // Only show index rows if underlyingIndexSeries is provided and non-empty
    if (underlyingIndexSeries && underlyingIndexSeries.length > 0) {
      if (underlyingIndexSeries.length > 1) {
        // Multiple indexes (e.g. SP500 + Nasdaq) — build a row for each
        for (const series of underlyingIndexSeries) {
          indexRows.push(buildIndexRowFromValues(series.dates, series.values, series.label, series.index));
        }
      } else {
        // Single index — use the canonical nonLeveragedValues
        indexRows.push(buildIndexRow(result, indexLabel));
      }
    }
    return [...indexRows, ...result.etfResults];
  }, [result, indexLabel, underlyingIndexSeries]);

  const colorById = useMemo(() => {
    const colors = new Map<string, string>();
    // Match the chart's color assignment order:
    // underlying index series (0, 1, ...) → nominal baseline (skip in legend) → etf results
    const indexCount = (underlyingIndexSeries && underlyingIndexSeries.length > 0)
      ? underlyingIndexSeries.length
      : 0;
    if (underlyingIndexSeries && underlyingIndexSeries.length > 1) {
      underlyingIndexSeries.forEach((s, i) => {
        colors.set(`__index_${s.index}__`, getDistinctColor(i));
      });
    } else if (underlyingIndexSeries && underlyingIndexSeries.length === 1) {
      colors.set("__index__", getDistinctColor(0));
    }
    // +1 to skip the unlabeled nominal baseline series in the chart
    const etfColorOffset = indexCount + 1;
    result.etfResults.forEach((etf, i) => {
      colors.set(etf.id, getDistinctColor(etfColorOffset + i));
    });
    return colors;
  }, [result.etfResults, underlyingIndexSeries]);

  const sorted = useMemo(() => {
    const direction = sortDir === "asc" ? 1 : -1;
    const calcRealReturn = (r: EtfResult) => {
      const initial = realValueInitialEquity(r);
      const realFinalValue = r.finalValue / rowInflation(r).factor;
      return ((realFinalValue / initial) - 1) * 100;
    };
    return [...rows].sort((a, b) => {
      if (sortKey === "finalValue") {
        return (calcRealReturn(a) - calcRealReturn(b)) * direction;
      }
      if (sortKey === "realCagr") {
        return ((a.cagr - rowInflation(a).rate * 100) - (b.cagr - rowInflation(b).rate * 100)) * direction;
      }
      if (sortKey === "inflationPct") {
        return (rowInflation(a).rate - rowInflation(b).rate) * direction;
      }
      if (sortKey === "startDate") {
        return ((a.dates[0] ?? "").localeCompare(b.dates[0] ?? "")) * direction;
      }
      if (sortKey === "avgActualLeverage") {
        const aLev = avgActualLeverageById?.[a.id];
        const bLev = avgActualLeverageById?.[b.id];
        const aMissing = !Number.isFinite(aLev);
        const bMissing = !Number.isFinite(bLev);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return ((aLev as number) - (bLev as number)) * direction;
      }
      if (sortKey === "maxLeverageDeltaPct") {
        const aLev = maxLeverageDeltaById?.[a.id];
        const bLev = maxLeverageDeltaById?.[b.id];
        const aMissing = !Number.isFinite(aLev);
        const bMissing = !Number.isFinite(bLev);
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        return ((aLev as number) - (bLev as number)) * direction;
      }
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * direction;
      }
      return String(av).localeCompare(String(bv)) * direction;
    });
    // calcRealReturn closes rowInflation + realValueInitialEquity (variant/result); listing all stables is noisy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortDir, sortKey, rawInflation, monthlyCpi, variant, result]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  };

  function getRealFinalValueMultiple(r: EtfResult): number {
    const initial = realValueInitialEquity(r);
    const realFinalValue = r.finalValue / rowInflation(r).factor;
    return realFinalValue / initial;
  }

  function buildMetricBacktestUrl(dates?: { start: string; end: string }): string | null {
    if (!dates) return null;
    const params = new URLSearchParams(searchParams.toString());
    params.set("sd", dates.start);
    params.set("ed", dates.end);
    return buildToolsUrl(metricLinkTab, params, { autorun: true });
  }

  if (result.etfResults.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={resultTableTestId}>
        <thead>
          <tr className="border-b border-card-border text-left text-muted">
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Name" active={sortKey === "name"} dir={sortDir} onClick={() => toggleSort("name")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Start" active={sortKey === "startDate"} dir={sortDir} onClick={() => toggleSort("startDate")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Real End Value" active={sortKey === "finalValue"} dir={sortDir} onClick={() => toggleSort("finalValue")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Real CAGR" active={sortKey === "realCagr"} dir={sortDir} onClick={() => toggleSort("realCagr")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Max Drawdown" active={sortKey === "maxDrawdownPct"} dir={sortDir} onClick={() => toggleSort("maxDrawdownPct")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Longest DD" active={sortKey === "longestDrawdownDays"} dir={sortDir} onClick={() => toggleSort("longestDrawdownDays")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Sharpe" active={sortKey === "sharpeRatio"} dir={sortDir} onClick={() => toggleSort("sharpeRatio")} />
            </th>
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="Total Trade Cost" active={sortKey === "totalTradingCostPct"} dir={sortDir} onClick={() => toggleSort("totalTradingCostPct")} />
            </th>
            {variant === "backtest" && (
              <>
                <th className="pb-2 pr-4 font-medium">
                  <SortButton label="Best Month" active={sortKey === "bestMonth"} dir={sortDir} onClick={() => toggleSort("bestMonth")} />
                </th>
                <th className="pb-2 pr-4 font-medium">
                  <SortButton label="Worst Month" active={sortKey === "worstMonth"} dir={sortDir} onClick={() => toggleSort("worstMonth")} />
                </th>
              </>
            )}
            {variant === "futures" && (
              <>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap">
                  <SortButton label="Avg Leverage" active={sortKey === "avgActualLeverage"} dir={sortDir} onClick={() => toggleSort("avgActualLeverage")} />
                </th>
                <th className="pb-2 pr-4 font-medium whitespace-nowrap">
                  <SortButton label="Max Leverage Δ" active={sortKey === "maxLeverageDeltaPct"} dir={sortDir} onClick={() => toggleSort("maxLeverageDeltaPct")} />
                </th>
              </>
            )}
            <th className="pb-2 pr-4 font-medium">
              <SortButton label="CAGR" active={sortKey === "cagr"} dir={sortDir} onClick={() => toggleSort("cagr")} />
            </th>
            <th className="pb-2 pr-4 font-medium whitespace-nowrap">
              <SortButton label="Inflation" active={sortKey === "inflationPct"} dir={sortDir} onClick={() => toggleSort("inflationPct")} />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const rowInflPct = rowInflation(r).rate * 100;
            return (
            <tr
              key={r.id}
              className="border-b border-card-border/50"
            >
              <td className="py-2.5 pr-4 font-medium">
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: colorById.get(r.id) ?? "#9ca3af" }}
                  />
                  <span>{shortBacktestAssetLabel(r.name)}</span>
                </span>
              </td>
              <td className="py-2.5 pr-4 text-muted">{r.dates[0] ?? "—"}</td>
              <td className="py-2.5 pr-4 font-medium text-blue-400">
                {formatMultiple(getRealFinalValueMultiple(r))}
              </td>
              <td
                className={`py-2.5 pr-4 ${
                  r.cagr - rowInflPct >= 0 ? "text-positive" : "text-negative"
                }`}
              >
                {formatPercent(r.cagr - rowInflPct)}
              </td>
              <td className="py-2.5 pr-4 text-negative">
                {formatPercent(r.maxDrawdownPct)}
                <DateRangeLink
                  dates={r.maxDrawdownDates}
                  href={buildMetricBacktestUrl(r.maxDrawdownDates)}
                />
              </td>
              <td className="py-2.5 pr-4 text-negative">
                {(r.longestDrawdownDays / 365.25).toFixed(1)}y
                <DateRangeLink
                  dates={r.longestDrawdownDates}
                  href={buildMetricBacktestUrl(r.longestDrawdownDates)}
                />
              </td>
              <td className="py-2.5 pr-4">{(r.sharpeRatio ?? 0).toFixed(2)}</td>
              <td className="py-2.5 pr-4 text-muted">
                {formatPercent(r.totalTradingCostPct ?? 0)}
              </td>
              {variant === "backtest" && (
                <>
                  <td className="py-2.5 pr-4 text-positive">
                    {formatPercent(r.bestMonth ?? 0)}
                    <DateRangeLink
                      dates={r.bestMonthDates}
                      href={buildMetricBacktestUrl(r.bestMonthDates)}
                      label={formatMonthLinkLabel(r.bestMonthDates)}
                    />
                  </td>
                  <td className="py-2.5 pr-4 text-negative">
                    {formatPercent(r.worstMonth ?? 0)}
                    <DateRangeLink
                      dates={r.worstMonthDates}
                      href={buildMetricBacktestUrl(r.worstMonthDates)}
                      label={formatMonthLinkLabel(r.worstMonthDates)}
                    />
                  </td>
                </>
              )}
              {variant === "futures" && (
                <>
                  <td className="py-2.5 pr-4 text-muted tabular-nums whitespace-nowrap">
                    {Number.isFinite(avgActualLeverageById?.[r.id] ?? NaN)
                      ? `${(avgActualLeverageById?.[r.id] ?? 0).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}x`
                      : "—"}
                  </td>
                  <td className="py-2.5 pr-4 text-muted">
                    {Number.isFinite(maxLeverageDeltaById?.[r.id] ?? NaN)
                      ? formatPercent(maxLeverageDeltaById?.[r.id] ?? 0)
                      : "—"}
                  </td>
                </>
              )}
              <td className="py-2.5 pr-4 font-medium text-yellow-500">
                {formatPercent(r.cagr)}
              </td>
              <td className="py-2.5 pr-4 text-muted">{formatPercent(rowInflPct)}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const ResultsTable = memo(ResultsTableImpl);

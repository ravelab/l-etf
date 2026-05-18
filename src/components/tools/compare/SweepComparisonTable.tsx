"use client";

import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useMaxPageButtons } from "@/lib/hooks/use-max-page-buttons";
import Link from "next/link";
import { SortButton } from "@/components/ui/SortButton";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { formatMultiple, formatPercent, formatCostPercent } from "@/lib/format";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import { formatDateSpan } from "@/lib/utils";
import type { SmaComparisonRow } from "@/lib/simulation/types";
import { scoreRow } from "@/lib/simulation/score";

type SweepSortKey =
  | "parameterValue"
  | "score"
  | "avgFinalRealValue"
  | "avgCagr"
  | "avgRealCagr"
  | "bestRealCagr"
  | "worstRealCagr"
  | "avgMaxDrawdown"
  | "biggestMaxDrawdown"
  | "avgTrades"
  | "avgTradingCostPct";

const PAGE_SIZE = 10;

export function SweepComparisonTable({
  rows,
  baseline,
  inflationPct,
  windowYears = 1,
  firstColumnLabel,
  formatFirstColumn,
  firstColumnInfo,
  getBacktestUrl,
  colorDot,
  pagination = true,
  startDate,
  showStartDate = true,
  resultTableTestId,
  hateDrawdown = false,
  showAvgTrades = true,
  showAvgCagr = false,
}: {
  rows: SmaComparisonRow[];
  baseline?: SmaComparisonRow | null;
  inflationPct: number;
  windowYears?: number;
  firstColumnLabel: string;
  formatFirstColumn: (row: SmaComparisonRow) => string;
  /** Optional per-row description rendered as an info popover next to the first-column label. */
  firstColumnInfo?: (row: SmaComparisonRow) => ReactNode | null;
  getBacktestUrl: (row: SmaComparisonRow, dates: { start: string; end: string }) => string | null;
  colorDot?: (row: SmaComparisonRow, originalIdx: number) => string | undefined;
  pagination?: boolean;
  startDate?: string;
  showStartDate?: boolean;
  /** Stable selector for E2E / snapshot tests (must be unique per page when multiple tables mount). */
  resultTableTestId?: string;
  /** When true, scores weight average max drawdown more heavily. */
  hateDrawdown?: boolean;
  showAvgTrades?: boolean;
  showAvgCagr?: boolean;
}) {
  const [sortKey, setSortKey] = useState<SweepSortKey>("score");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const maxButtons = useMaxPageButtons();

  const toggleSort = useCallback(
    (key: SweepSortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return;
      }
      setSortKey(key);
      setSortDir(key === "parameterValue" ? "asc" : "desc");
      setPage(0);
    },
    [sortKey]
  );

  const yearsForRow = useCallback(
    (r: SmaComparisonRow) => r.avgWindowYears && r.avgWindowYears > 0 ? r.avgWindowYears : windowYears,
    [windowYears]
  );

  const scoreOf = useCallback(
    (r: SmaComparisonRow) => scoreRow(r, inflationPct, yearsForRow(r), { hateDrawdown }),
    [inflationPct, yearsForRow, hateDrawdown]
  );

  const metricFns: Record<string, (r: SmaComparisonRow) => number> = {
    score: scoreOf,
    avgFinalRealValue: (r) => r.avgFinalRealValue,
    avgCagr: (r) => r.avgCagr ?? r.avgReturn,
    avgRealCagr: (r) => r.avgReturn - inflationPct,
    bestRealCagr: (r) => r.bestReturn - inflationPct,
    worstRealCagr: (r) => r.worstReturn - inflationPct,
    avgTrades: (r) => r.avgTrades / Math.max(1e-9, yearsForRow(r)),
  };

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const metricFn = metricFns[sortKey];
    if (metricFn) {
      return [...rows].sort((a, b) => (metricFn(a) - metricFn(b)) * dir);
    }
    const key = sortKey as keyof SmaComparisonRow;
    return [...rows].sort((a, b) => ((a[key] as number) - (b[key] as number)) * dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sortKey, sortDir, inflationPct, hateDrawdown]);

  const totalPages = pagination ? Math.ceil(sorted.length / PAGE_SIZE) : 1;
  const paged = pagination ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : sorted;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid={resultTableTestId}>
          <thead>
            <tr className="border-b border-card-border text-left text-muted">
              <th className="pb-2 pr-4 font-medium">
                <SortButton label={firstColumnLabel} active={sortKey === "parameterValue"} dir={sortDir} onClick={() => toggleSort("parameterValue")} />
              </th>
              {showStartDate && startDate && (
                <th className="pb-2 pr-4 font-medium w-20">Start</th>
              )}
              <th className="pb-2 pr-4 font-medium w-28 [&_button]:flex [&_button]:whitespace-normal [&_button]:text-left">
                <SortButton label="Avg Real End Value" active={sortKey === "avgFinalRealValue"} dir={sortDir} onClick={() => toggleSort("avgFinalRealValue")} />
              </th>
              <th className="pb-2 pr-4 font-medium">
                <SortButton label="Avg Real CAGR" active={sortKey === "avgRealCagr"} dir={sortDir} onClick={() => toggleSort("avgRealCagr")} />
              </th>
              <th className="pb-2 pr-4 font-medium">
                <SortButton label="Avg Max Drawdown" active={sortKey === "avgMaxDrawdown"} dir={sortDir} onClick={() => toggleSort("avgMaxDrawdown")} />
              </th>
              <th className="pb-2 pr-4 font-medium whitespace-nowrap">
                <SortButton label="Biggest DD" active={sortKey === "biggestMaxDrawdown"} dir={sortDir} onClick={() => toggleSort("biggestMaxDrawdown")} />
              </th>
              {showAvgTrades && (
                <th className="pb-2 pr-4 font-medium w-28 [&_button]:flex [&_button]:whitespace-normal [&_button]:text-left">
                  <SortButton label="Avg Trades per Year" active={sortKey === "avgTrades"} dir={sortDir} onClick={() => toggleSort("avgTrades")} />
                </th>
              )}
              <th className="pb-2 pr-4 font-medium w-28 [&_button]:flex [&_button]:whitespace-normal [&_button]:text-left">
                <SortButton label="Avg Total Trade Cost" active={sortKey === "avgTradingCostPct"} dir={sortDir} onClick={() => toggleSort("avgTradingCostPct")} />
              </th>
              <th className="pb-2 pr-4 font-medium">
                <SortButton label="Best Real CAGR" active={sortKey === "bestRealCagr"} dir={sortDir} onClick={() => toggleSort("bestRealCagr")} />
              </th>
              <th className="pb-2 pr-4 font-medium">
                <SortButton label="Worst Real CAGR" active={sortKey === "worstRealCagr"} dir={sortDir} onClick={() => toggleSort("worstRealCagr")} />
              </th>
              {showAvgCagr && (
                <th className="pb-2 pr-4 font-medium">
                  <SortButton label="Avg CAGR" active={sortKey === "avgCagr"} dir={sortDir} onClick={() => toggleSort("avgCagr")} />
                </th>
              )}
              <th className="pb-2 pr-4 font-medium">
                <SortButton label="Score" active={sortKey === "score"} dir={sortDir} onClick={() => toggleSort("score")} />
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((row, idx) => {
              const avg = row.avgReturn - inflationPct;
              const best = row.bestReturn - inflationPct;
              const worst = row.worstReturn - inflationPct;
              const score = scoreOf(row);
              const originalIdx = rows.indexOf(row);
              const dotColor = colorDot?.(row, originalIdx);
              const bestUrl = row.bestReturnDates ? getBacktestUrl(row, row.bestReturnDates) : null;
              const worstUrl = row.worstReturnDates ? getBacktestUrl(row, row.worstReturnDates) : null;
              const ddUrl = row.biggestMaxDrawdownDates ? getBacktestUrl(row, row.biggestMaxDrawdownDates) : null;
              return (
                <tr key={`${row.parameterValue}-${idx}`} className="border-b border-card-border/50">
                  <td className="py-2.5 pr-4 font-medium">
                    <span className="flex items-center gap-2">
                      {dotColor && <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: dotColor }} />}
                      <span>{formatFirstColumn(row)}</span>
                      {firstColumnInfo ? (() => {
                        const info = firstColumnInfo(row);
                        return info ? (
                          <span className="ml-auto">
                            <InfoPopoverButton label={formatFirstColumn(row)}>{info}</InfoPopoverButton>
                          </span>
                        ) : null;
                      })() : null}
                    </span>
                  </td>
                  {showStartDate && startDate && (
                    <td className="py-2.5 pr-4 text-muted w-20 leading-tight">{row.earliestStartDate!}</td>
                  )}
                  <td className="py-2.5 pr-4 text-right text-value-accent">
                    {formatMultiple(row.avgFinalRealValue / CONSTANT_INITIAL_INVESTMENT)}
                  </td>
                  <td className={`py-2.5 pr-4 text-right ${avg >= 0 ? "text-positive" : "text-negative"}`}>
                    {formatPercent(avg)}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-negative">
                    {formatPercent(row.avgMaxDrawdown)}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-negative whitespace-nowrap">
                    {formatPercent(row.biggestMaxDrawdown)}
                    {row.biggestMaxDrawdownDates && (
                      ddUrl ? (
                        <Link href={ddUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(row.biggestMaxDrawdownDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(row.biggestMaxDrawdownDates)}
                        </span>
                      )
                    )}
                  </td>
                  {showAvgTrades && (
                    <td className="py-2.5 pr-4 text-right tabular-nums">{(row.avgTrades / Math.max(1e-9, yearsForRow(row))).toFixed(2)}</td>
                  )}
                  <td className="py-2.5 pr-4 text-right text-muted">{formatCostPercent(row.avgTradingCostPct)}</td>
                  <td className="py-2.5 pr-4 text-right text-positive">
                    {formatPercent(best)}
                    {row.bestReturnDates && (
                      bestUrl ? (
                        <Link href={bestUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(row.bestReturnDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(row.bestReturnDates)}
                        </span>
                      )
                    )}
                  </td>
                  <td className={`py-2.5 pr-4 text-right ${worst < 0 ? "text-negative" : "text-foreground"}`}>
                    {formatPercent(worst)}
                    {row.worstReturnDates && (
                      worstUrl ? (
                        <Link href={worstUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(row.worstReturnDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(row.worstReturnDates)}
                        </span>
                      )
                    )}
                  </td>
                  {showAvgCagr && (
                    <td className="py-2.5 pr-4 text-right font-medium text-yellow-500">
                      {formatPercent(row.avgCagr ?? row.avgReturn)}
                    </td>
                  )}
                  <td className={`py-2.5 pr-4 text-right font-medium ${score >= 0 ? "text-score" : "text-negative"}`}>
                    {score.toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {baseline && (() => {
              const blAvg = baseline.avgReturn - inflationPct;
              const blBest = baseline.bestReturn - inflationPct;
              const blWorst = baseline.worstReturn - inflationPct;
              const blScore = scoreRow(baseline, inflationPct, yearsForRow(baseline), { hateDrawdown });
              const baselineBestUrl = baseline.bestReturnDates ? getBacktestUrl(baseline, baseline.bestReturnDates) : null;
              const baselineWorstUrl = baseline.worstReturnDates ? getBacktestUrl(baseline, baseline.worstReturnDates) : null;
              const baselineDdUrl = baseline.biggestMaxDrawdownDates ? getBacktestUrl(baseline, baseline.biggestMaxDrawdownDates) : null;
              return (
                <tr className="border-t-2 border-card-border bg-card-border/10">
                  <td className="py-2.5 pr-4 italic text-muted">No SMA</td>
                  {showStartDate && startDate && (
                    <td className="py-2.5 pr-4 text-muted w-20 leading-tight">{baseline.earliestStartDate!}</td>
                  )}
                  <td className="py-2.5 pr-4 text-right text-value-accent">
                    {formatMultiple(baseline.avgFinalRealValue / CONSTANT_INITIAL_INVESTMENT)}
                  </td>
                  <td className={`py-2.5 pr-4 text-right ${blAvg >= 0 ? "text-positive" : "text-negative"}`}>
                    {formatPercent(blAvg)}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-negative">
                    {formatPercent(baseline.avgMaxDrawdown)}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-negative whitespace-nowrap">
                    {formatPercent(baseline.biggestMaxDrawdown)}
                    {baseline.biggestMaxDrawdownDates && (
                      baselineDdUrl ? (
                        <Link href={baselineDdUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(baseline.biggestMaxDrawdownDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(baseline.biggestMaxDrawdownDates)}
                        </span>
                      )
                    )}
                  </td>
                  {showAvgTrades && (
                    <td className="py-2.5 pr-4 text-right">0.0</td>
                  )}
                  <td className="py-2.5 pr-4 text-right text-muted">{formatCostPercent(baseline.avgTradingCostPct)}</td>
                  <td className="py-2.5 pr-4 text-right text-positive">
                    {formatPercent(blBest)}
                    {baseline.bestReturnDates && (
                      baselineBestUrl ? (
                        <Link href={baselineBestUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(baseline.bestReturnDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(baseline.bestReturnDates)}
                        </span>
                      )
                    )}
                  </td>
                  <td className={`py-2.5 pr-4 text-right ${blWorst < 0 ? "text-negative" : "text-foreground"}`}>
                    {formatPercent(blWorst)}
                    {baseline.worstReturnDates && (
                      baselineWorstUrl ? (
                        <Link href={baselineWorstUrl} className="text-[10px] text-accent hover:underline block">
                          {formatDateSpan(baseline.worstReturnDates)}
                        </Link>
                      ) : (
                        <span className="text-[10px] text-muted block">
                          {formatDateSpan(baseline.worstReturnDates)}
                        </span>
                      )
                    )}
                  </td>
                  {showAvgCagr && (
                    <td className="py-2.5 pr-4 text-right font-medium text-yellow-500">
                      {formatPercent(baseline.avgCagr ?? baseline.avgReturn)}
                    </td>
                  )}
                  <td className={`py-2.5 pr-4 text-right font-medium ${blScore >= 0 ? "text-score" : "text-negative"}`}>
                    {blScore.toFixed(2)}
                  </td>
                </tr>
              );
            })()}
          </tbody>
        </table>
      </div>
      {pagination && totalPages > 1 && (
        <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-muted">
          <span>
            {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
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

// Shape a full `EtfResult` (plus the run's non-leveraged baseline) into a
// compact, agent-friendly payload. Drops the heavy per-day arrays and keeps the
// headline metrics and trade log.

import type { BacktestResult, EtfResult, SmaComparisonRow } from "@/lib/simulation/types";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";

export interface FormattedBacktest {
  name: string;
  index: string;
  startDate: string;
  endDate: string;
  finalMultiple: number;
  cagrPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  maxDrawdownDates?: { start: string; end: string };
  longestDrawdownDays: number;
  bestMonthPct: number;
  worstMonthPct: number;
  totalTradingCostPct: number;
  smaStartInvested?: boolean;
  numTrades: number;
  trades: Array<{ date: string; type: "buy" | "sell"; price: number }>;
  benchmark: { name: string; finalMultiple: number };
  // Present only for SMA strategies: the same LETF held buy-and-hold (no SMA),
  // which the engine computes alongside the SMA path.
  noSmaComparison?: { finalMultiple: number; cagrPct: number; maxDrawdownPct: number };
}

export function formatBacktest(
  result: BacktestResult,
  etf: EtfResult,
  noSmaEtf?: EtfResult,
): FormattedBacktest {
  const dates = result.dates;
  const nonLeveraged = result.nonLeveragedValues;
  const benchmarkFinal =
    nonLeveraged.length > 0 ? nonLeveraged[nonLeveraged.length - 1] / CONSTANT_INITIAL_INVESTMENT : 0;

  return {
    name: etf.name,
    index: etf.sourceIndex,
    startDate: dates[0] ?? "",
    endDate: dates[dates.length - 1] ?? "",
    finalMultiple: etf.finalValue / CONSTANT_INITIAL_INVESTMENT,
    cagrPct: etf.cagr,
    sharpeRatio: etf.sharpeRatio,
    maxDrawdownPct: etf.maxDrawdownPct,
    maxDrawdownDates: etf.maxDrawdownDates,
    longestDrawdownDays: etf.longestDrawdownDays,
    bestMonthPct: etf.bestMonth,
    worstMonthPct: etf.worstMonth,
    totalTradingCostPct: etf.totalTradingCostPct,
    smaStartInvested: etf.smaStartInvested,
    numTrades: etf.smaSignals.length,
    trades: etf.smaSignals.map((s) => ({ date: s.date, type: s.type, price: s.price })),
    benchmark: { name: "1x index (no leverage, no fees)", finalMultiple: benchmarkFinal },
    ...(noSmaEtf
      ? {
          noSmaComparison: {
            finalMultiple: noSmaEtf.finalValue / CONSTANT_INITIAL_INVESTMENT,
            cagrPct: noSmaEtf.cagr,
            maxDrawdownPct: noSmaEtf.maxDrawdownPct,
          },
        }
      : {}),
  };
}

export interface FormattedSweepRow {
  id: string;
  label: string;
  avgReturnPct: number;
  avgCagrPct?: number;
  bestReturnPct: number;
  worstReturnPct: number;
  avgMaxDrawdownPct: number;
  worstMaxDrawdownPct: number;
  winRatePct?: number;
  avgTrades: number;
  avgWindowYears?: number;
}

/** Compact a rolling-window aggregate row for tool output. */
export function formatSweepRow(id: string, label: string, row: SmaComparisonRow): FormattedSweepRow {
  return {
    id,
    label,
    avgReturnPct: row.avgReturn,
    avgCagrPct: row.avgCagr,
    bestReturnPct: row.bestReturn,
    worstReturnPct: row.worstReturn,
    avgMaxDrawdownPct: row.avgMaxDrawdown,
    worstMaxDrawdownPct: row.biggestMaxDrawdown,
    winRatePct: row.winRate,
    avgTrades: row.avgTrades,
    avgWindowYears: row.avgWindowYears,
  };
}

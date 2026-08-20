// Distill the site's precomputed tool snapshots into agent-sized payloads.
//
// `src/lib/tool-snapshots/*.json` holds one canonical run per tool page, but
// they embed full daily series (backtesting ~1.8MB, futures ~4MB) because the
// pages hydrate charts from them. Everything here strips those arrays and keeps
// the headline numbers, so an agent can answer the common questions without
// spending the heavy rate-limit budget re-running the engine.
//
// Snapshots are generated with history wrap ENABLED, while the MCP tools all run
// `historyWrap:false` — hence the caveat attached to every payload. Do not
// compare a snapshot figure against a live tool figure without accounting for it.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";
import type { SmaComparisonRow } from "@/lib/simulation/types";
import { McpToolError } from "@/lib/mcp/tool-result";

export const SNAPSHOT_ANALYSES = [
  "backtesting",
  "compare-letfs",
  "compare-sma",
  "compare-threshold",
  "compare-riskoff-assets",
  "statistical-analysis",
  "futures",
] as const;

export type SnapshotAnalysis = (typeof SNAPSHOT_ANALYSES)[number];

const SNAPSHOT_FILES: Record<SnapshotAnalysis, string> = {
  backtesting: "backtesting.json",
  "compare-letfs": "compare-letfs.json",
  "compare-sma": "compare-sma.json",
  "compare-threshold": "compare-threshold.json",
  "compare-riskoff-assets": "compare-riskoff-assets.json",
  "statistical-analysis": "statistical-analysis.json",
  futures: "futures.json",
};

const TITLES: Record<SnapshotAnalysis, string> = {
  backtesting: "Single-period backtest with trade-level detail (/backtesting-tool)",
  "compare-letfs": "Leveraged ETFs across rolling windows, percentile outcomes (/compare-letfs)",
  "compare-sma": "SMA-period sweep over rolling windows (/compare-sma-strategies)",
  "compare-threshold": "SMA-buffer sweep, symmetric and 2-D asymmetric (/compare-threshold-strategies)",
  "compare-riskoff-assets": "Risk-off asset comparison over rolling windows (/compare-riskoff-assets)",
  "statistical-analysis": "Win rates by holding period (/statistical-analysis)",
  futures: "Index-futures ladder with margin scenarios (/futures-tool)",
};

const CAVEAT =
  "Precomputed snapshot of the site's canonical run, not a fresh simulation. It was generated with " +
  "history wrap ENABLED (windows may extend past today on a synthetic tail, so best/worst dates can " +
  "be in the future), while every live l-etf tool runs with history wrap disabled — do not compare " +
  "these figures directly against tool output. Re-run the matching tool for a like-for-like number.";

const TOP_CELLS = 15;

interface RawSnapshot {
  generatedAt: string;
  snapshotEndDate: string;
  sharedInputs: Record<string, unknown>;
  pageKey: string;
  pageState: Record<string, unknown>;
}

interface EtfResultLike {
  id: string;
  name: string;
  sourceIndex: string;
  finalValue: number;
  cagr: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  longestDrawdownDays: number;
  totalTradingCostPct: number;
}

interface AsymRowLike extends SmaComparisonRow {
  upperBuffer: number;
  lowerBuffer: number;
  stage: string;
}

async function readSnapshot(analysis: SnapshotAnalysis): Promise<RawSnapshot> {
  const path = join(process.cwd(), "src", "lib", "tool-snapshots", SNAPSHOT_FILES[analysis]);
  try {
    return JSON.parse(await readFile(path, "utf-8")) as RawSnapshot;
  } catch {
    throw new McpToolError(`The precomputed "${analysis}" snapshot is unavailable.`);
  }
}

/** Headline metrics for one simulated series, minus its daily arrays. */
function summarizeEtfResult(result: EtfResultLike) {
  return {
    id: result.id,
    name: result.name,
    index: result.sourceIndex,
    finalMultiple: result.finalValue / CONSTANT_INITIAL_INVESTMENT,
    cagrPct: result.cagr,
    sharpeRatio: result.sharpeRatio,
    maxDrawdownPct: result.maxDrawdownPct,
    longestDrawdownDays: result.longestDrawdownDays,
    totalTradingCostPct: result.totalTradingCostPct,
  };
}

/** One rolling-window sweep row, keyed by whatever the sweep varied. */
function summarizeSweepRow(row: SmaComparisonRow) {
  return {
    parameterValue: row.parameterValue,
    avgCagrPct: row.avgCagr,
    avgReturnPct: row.avgReturn,
    bestReturnPct: row.bestReturn,
    worstReturnPct: row.worstReturn,
    avgMaxDrawdownPct: row.avgMaxDrawdown,
    worstMaxDrawdownPct: row.biggestMaxDrawdown,
    winRatePct: row.winRate,
    avgTrades: row.avgTrades,
  };
}

function summarizeAsymRows(rows: AsymRowLike[] | undefined) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { asymmetricCellsEvaluated: 0, topAsymmetricCells: [] };
  }
  const topAsymmetricCells = [...rows]
    .sort((a, b) => (b.avgCagr ?? 0) - (a.avgCagr ?? 0))
    .slice(0, TOP_CELLS)
    .map((row) => ({
      upperBuffer: row.upperBuffer,
      lowerBuffer: row.lowerBuffer,
      stage: row.stage,
      avgCagrPct: row.avgCagr ?? 0,
      avgReturnPct: row.avgReturn,
      worstReturnPct: row.worstReturn,
      avgMaxDrawdownPct: row.avgMaxDrawdown,
      avgTrades: row.avgTrades,
    }));
  return { asymmetricCellsEvaluated: rows.length, topAsymmetricCells };
}

/** Both index panels of a two-sided compare page, with their baselines. */
function summarizeTwoIndexSweep(state: Record<string, unknown>) {
  const panel = (rows: unknown, baseline: unknown) => ({
    rows: Array.isArray(rows) ? (rows as SmaComparisonRow[]).map(summarizeSweepRow) : [],
    baseline: baseline ? summarizeSweepRow(baseline as SmaComparisonRow) : undefined,
  });
  return {
    sp500: panel(state.rows, state.baseline),
    nasdaq100: panel(state.rows2, state.baseline2),
  };
}

function distill(analysis: SnapshotAnalysis, state: Record<string, unknown>): unknown {
  switch (analysis) {
    case "backtesting": {
      const result = state.result as { dates: string[]; etfResults: EtfResultLike[]; nonLeveragedValues: number[] };
      const nonLeveraged = result.nonLeveragedValues ?? [];
      return {
        startDate: result.dates[0],
        endDate: result.dates[result.dates.length - 1],
        strategies: result.etfResults.map(summarizeEtfResult),
        benchmark: {
          name: "1x index (no leverage, no fees)",
          finalMultiple:
            nonLeveraged.length > 0
              ? nonLeveraged[nonLeveraged.length - 1] / CONSTANT_INITIAL_INVESTMENT
              : null,
        },
      };
    }

    case "compare-letfs": {
      const summary = state.snapshotSummary as { rows: SmaComparisonRow[]; labels: string[] } | undefined;
      const distribution = state.distributionSnapshot as
        | { rows: Array<Record<string, unknown>> }
        | undefined;
      return {
        strategies: (summary?.rows ?? []).map((row, i) => ({
          label: summary?.labels?.[i] ?? `row-${i}`,
          ...summarizeSweepRow(row),
        })),
        percentileDistribution: distribution?.rows ?? [],
      };
    }

    case "compare-sma":
      return { sweptParameter: "smaPeriod", ...summarizeTwoIndexSweep(state) };

    case "compare-threshold": {
      const symmetric = summarizeTwoIndexSweep(state);
      return {
        sweptParameter: "symmetric buffer % (rows), plus a 2-D upper/lower grid",
        fineGridWindow: state.asymFineWindow,
        sp500: { ...symmetric.sp500, ...summarizeAsymRows(state.asymRows as AsymRowLike[]) },
        nasdaq100: { ...symmetric.nasdaq100, ...summarizeAsymRows(state.asymRows2 as AsymRowLike[]) },
      };
    }

    case "compare-riskoff-assets": {
      const panel = (rows: unknown, baseline: unknown) => ({
        assets: Array.isArray(rows)
          ? (rows as Array<{ riskOffAsset: string; displayLabel: string; summary: SmaComparisonRow }>).map(
              (row) => ({
                riskOffAsset: row.riskOffAsset,
                label: row.displayLabel,
                ...summarizeSweepRow(row.summary),
              }),
            )
          : [],
        baseline: baseline ? summarizeSweepRow(baseline as SmaComparisonRow) : undefined,
      });
      return { sp500: panel(state.rows, state.baseline), nasdaq100: panel(state.rows2, state.baseline2) };
    }

    case "statistical-analysis": {
      const byWindow = state.winRatesByWindow as
        | Array<{
            label: string;
            earliestStartDate: string;
            years: number[];
            beatsNonSma: number[];
            beatsIndex: number[];
            beatsSgov: number[];
          }>
        | undefined;
      return {
        strategies: (byWindow ?? []).map((entry) => ({
          label: entry.label,
          earliestStartDate: entry.earliestStartDate,
          holdingPeriodYears: entry.years,
          winRatePctVsNoSma: entry.beatsNonSma,
          winRatePctVsIndex: entry.beatsIndex,
          winRatePctVsSgov: entry.beatsSgov,
        })),
      };
    }

    case "futures": {
      const details = state.futuresDetails as
        | Array<{
            etfResult: EtfResultLike;
            targetLeverage: number;
            index: string;
            initialEquity: number;
            avgActualLeverageRiskOn: number;
            maxAbsLeverageDeltaRiskOnPct: number;
            riskOffSessionDayCount: number;
            sessionDayCount: number;
          }>
        | undefined;
      return {
        initialEquity: state.amount,
        leverageTolerancePct: state.leverageTolerancePct,
        ladder: (details ?? []).map((entry) => ({
          ...summarizeEtfResult(entry.etfResult),
          targetLeverage: entry.targetLeverage,
          futuresIndex: entry.index,
          avgActualLeverageRiskOn: entry.avgActualLeverageRiskOn,
          maxAbsLeverageDeltaRiskOnPct: entry.maxAbsLeverageDeltaRiskOnPct,
          riskOffSessionDayCount: entry.riskOffSessionDayCount,
          sessionDayCount: entry.sessionDayCount,
        })),
      };
    }
  }
}

export interface SnapshotCatalogEntry {
  analysis: SnapshotAnalysis;
  title: string;
  generatedAt: string;
  snapshotEndDate: string;
}

/** What snapshots exist and how fresh each one is. */
export async function listSnapshots(): Promise<SnapshotCatalogEntry[]> {
  return Promise.all(
    SNAPSHOT_ANALYSES.map(async (analysis) => {
      const raw = await readSnapshot(analysis);
      return {
        analysis,
        title: TITLES[analysis],
        generatedAt: raw.generatedAt,
        snapshotEndDate: raw.snapshotEndDate,
      };
    }),
  );
}

export async function getSnapshot(analysis: SnapshotAnalysis) {
  const raw = await readSnapshot(analysis);
  return {
    analysis,
    title: TITLES[analysis],
    generatedAt: raw.generatedAt,
    snapshotEndDate: raw.snapshotEndDate,
    sharedInputs: raw.sharedInputs,
    caveat: CAVEAT,
    results: distill(analysis, raw.pageState),
  };
}

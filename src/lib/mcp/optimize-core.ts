// `optimize_strategy` orchestration: search the joint (SMA period x upper x
// lower) grid over rolling windows, and report the result with the evidence
// needed to judge whether it means anything.
//
// An optimizer run over one price history is a machine for producing
// curve-fitted parameters, so this deliberately never returns a bare winner.
// Every result carries two checks:
//
//   - a split-sample pass, which re-runs the whole grid on a half of history
//     the search never saw and reports where the in-sample winner ranks there;
//   - the winner's immediate grid neighbourhood, since an optimum whose
//     neighbours score far worse is a spike found in this particular history
//     rather than a parameter that would have held.
//
// Both are on by default. A caller can turn the split off for a short range,
// and the caveat says so in the output.

import { annualizedInflationForRange } from "@/lib/inflation";
import { scoreRow, type AsymmetricSweepRow, type ObjectiveKey } from "@/lib/simulation/buffer-grid-search";
import { makeSweepEtfConfig, type SweepPresetDef } from "@/lib/simulation/sweep-items";
import type { EtfConfig } from "@/lib/simulation/types";
import { runRollingSweep, type SweepProgress } from "@/lib/mcp/sweep-core";
import { loadInflation } from "@/lib/mcp/server-data";
import { formatSweepRow, type FormattedSweepRow } from "@/lib/mcp/format";
import { McpToolError } from "@/lib/mcp/tool-result";
import {
  findNeighbours,
  splitRangeInHalf,
  type DateRange,
  type GridCell,
} from "@/lib/mcp/optimize-grid";

type IndexKey = "sp500" | "nasdaq100";

interface ScoredCell extends FormattedSweepRow {
  smaPeriod: number;
  upperBuffer: number;
  lowerBuffer: number;
  score: number;
  /** 1-based position in this pass, best first. */
  rank: number;
}

interface PassResult {
  startDate: string;
  endDate: string;
  inflationPct: number;
  ranked: ScoredCell[];
  truncated: boolean;
}

interface OptimizeResult {
  objective: ObjectiveKey;
  windowLengthYears: number;
  gridCells: number;
  search: { startDate: string; endDate: string; inflationPct: number };
  best: ScoredCell;
  top: ScoredCell[];
  stability: {
    neighbours: Array<{ smaPeriod: number; upperBuffer: number; lowerBuffer: number; score: number }>;
    worstNeighbourScore: number | null;
    /** How far the worst neighbour falls below the winner, as a percent of it. */
    worstNeighbourDropPct: number | null;
    /** True when every neighbour stays within `PLATEAU_TOLERANCE_PCT` of the winner. */
    plateau: boolean;
  };
  outOfSample?: {
    startDate: string;
    endDate: string;
    inflationPct: number;
    /** Where the in-sample winner ranked on unseen history, out of `gridCells`. */
    winnerRank: number | null;
    winnerScore: number | null;
    /** What actually won out of sample — if it moved, the search was fitting. */
    ownBest: ScoredCell | null;
  };
  truncated: boolean;
  caveat: string;
}

/** A neighbour this close to the winner counts as the same region, not a cliff. */
const PLATEAU_TOLERANCE_PCT = 10;

const IN_SAMPLE_CAVEAT =
  "These parameters were selected by searching this same history, so their in-sample " +
  "ranking is not evidence they will hold. Read the split-sample rank and the " +
  "neighbourhood before treating any cell as a finding: a winner that ranks poorly " +
  "out of sample, or whose neighbours score far worse, is a fitting artifact.";

function presetDefFromBase(base: EtfConfig): SweepPresetDef {
  return {
    name: base.name,
    leverage: base.leverage,
    expenseRatio: base.expenseRatio,
    simulated: base.simulated,
    index: base.smaIndex,
  };
}

/** One EtfConfig per grid cell, sharing the page's own config builder. */
function buildOptimizationConfigs(base: EtfConfig, cells: GridCell[]): EtfConfig[] {
  const preset = presetDefFromBase(base);
  return cells.map((cell) =>
    makeSweepEtfConfig(preset, {
      id: cell.id,
      name: `${base.name} SMA ${cell.smaPeriod} U${cell.upperBuffer}/L${cell.lowerBuffer}`,
      smaEnabled: true,
      smaPeriod: cell.smaPeriod,
      smaUpperBuffer: cell.upperBuffer,
      smaLowerBuffer: cell.lowerBuffer,
      riskOffAsset: base.riskOffAsset,
      smaExecutionMode: base.smaExecutionMode,
    }),
  );
}

/** Run and rank the whole grid over one date range. */
async function runPass(params: {
  base: EtfConfig;
  index: IndexKey;
  cells: GridCell[];
  objective: ObjectiveKey;
  windowLength: number;
  range: DateRange;
  onProgress?: SweepProgress;
  signal?: AbortSignal;
}): Promise<PassResult> {
  const { base, index, cells, objective, windowLength, range, onProgress, signal } = params;
  const configs = buildOptimizationConfigs(base, cells);

  const [sweep, monthlyCpi] = await Promise.all([
    runRollingSweep({
      index,
      configs,
      windowLength,
      startDate: range.startDate,
      endDate: range.endDate,
      onProgress,
      signal,
    }),
    loadInflation(range.startDate, range.endDate),
  ]);
  if (sweep.rows.length === 0) {
    throw new McpToolError(
      `No valid rolling windows for this grid over ${range.startDate}..${range.endDate}.`,
    );
  }

  // `annualizedInflationForRange` returns a fraction while these rows are
  // percent and nominal (MCP never passes CPI into the engine), so scale it —
  // the same conversion the compare pages do.
  const inflationPct = annualizedInflationForRange(monthlyCpi, range.startDate, range.endDate) * 100;

  const byId = new Map(cells.map((c) => [c.id, c]));
  const scored = sweep.rows.flatMap((row) => {
    const cell = byId.get(row.id);
    if (!cell) return [];
    const asAsymmetric: AsymmetricSweepRow = {
      ...row.stats,
      upperBuffer: cell.upperBuffer,
      lowerBuffer: cell.lowerBuffer,
      stage: "coarse",
    };
    return [
      {
        ...formatSweepRow(row.id, row.label, row.stats),
        smaPeriod: cell.smaPeriod,
        upperBuffer: cell.upperBuffer,
        lowerBuffer: cell.lowerBuffer,
        score: scoreRow(asAsymmetric, objective, inflationPct),
        rank: 0,
      },
    ];
  });

  // Ties fall back to the slower SMA and the tighter band, so repeated calls
  // with the same inputs return the same winner.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.smaPeriod - a.smaPeriod ||
      a.upperBuffer - b.upperBuffer ||
      a.lowerBuffer - b.lowerBuffer,
  );
  const ranked = scored.map((cell, i) => ({ ...cell, rank: i + 1 }));

  return {
    startDate: range.startDate,
    endDate: range.endDate,
    inflationPct,
    ranked,
    truncated: sweep.truncated,
  };
}

export async function runOptimization(params: {
  base: EtfConfig;
  index: IndexKey;
  cells: GridCell[];
  objective: ObjectiveKey;
  windowLength: number;
  startDate: string;
  endDate: string;
  splitSample: boolean;
  topN: number;
  onProgress?: SweepProgress;
  signal?: AbortSignal;
}): Promise<OptimizeResult> {
  const { base, index, cells, objective, windowLength, splitSample, topN, onProgress, signal } =
    params;

  const split = splitSample
    ? splitRangeInHalf(params.startDate, params.endDate)
    : { inSample: { startDate: params.startDate, endDate: params.endDate }, outOfSample: null };

  // Two passes when splitting, so each reports into its own half of progress.
  const passProgress = (offset: number, span: number): SweepProgress | undefined =>
    onProgress ? (fraction, label) => onProgress(offset + fraction * span, label) : undefined;

  const inSample = await runPass({
    base,
    index,
    cells,
    objective,
    windowLength,
    range: split.inSample,
    onProgress: passProgress(0, split.outOfSample ? 0.5 : 1),
    signal,
  });

  const best = inSample.ranked[0];
  const scoreById = new Map(inSample.ranked.map((c) => [c.id, c.score]));
  const bestCell = cells.find((c) => c.id === best.id)!;
  const neighbours = findNeighbours(bestCell, cells)
    .map((n) => ({
      smaPeriod: n.smaPeriod,
      upperBuffer: n.upperBuffer,
      lowerBuffer: n.lowerBuffer,
      score: scoreById.get(n.id),
    }))
    .filter((n): n is { smaPeriod: number; upperBuffer: number; lowerBuffer: number; score: number } =>
      n.score !== undefined,
    );

  const worstNeighbourScore = neighbours.length > 0
    ? Math.min(...neighbours.map((n) => n.score))
    : null;
  // Relative to |best| so the drop reads the same whichever objective was used.
  const worstNeighbourDropPct =
    worstNeighbourScore !== null && Math.abs(best.score) > 0
      ? ((best.score - worstNeighbourScore) / Math.abs(best.score)) * 100
      : null;

  let outOfSample: OptimizeResult["outOfSample"];
  let truncated = inSample.truncated;
  if (split.outOfSample) {
    const pass = await runPass({
      base,
      index,
      cells,
      objective,
      windowLength,
      range: split.outOfSample,
      onProgress: passProgress(0.5, 0.5),
      signal,
    });
    const winnerRow = pass.ranked.find((c) => c.id === best.id);
    outOfSample = {
      startDate: pass.startDate,
      endDate: pass.endDate,
      inflationPct: pass.inflationPct,
      winnerRank: winnerRow?.rank ?? null,
      winnerScore: winnerRow?.score ?? null,
      ownBest: pass.ranked[0] ?? null,
    };
    truncated = truncated || pass.truncated;
  }

  return {
    objective,
    windowLengthYears: windowLength,
    gridCells: cells.length,
    search: {
      startDate: inSample.startDate,
      endDate: inSample.endDate,
      inflationPct: inSample.inflationPct,
    },
    best,
    top: inSample.ranked.slice(0, topN),
    stability: {
      neighbours,
      worstNeighbourScore,
      worstNeighbourDropPct,
      plateau:
        worstNeighbourDropPct !== null
          ? worstNeighbourDropPct <= PLATEAU_TOLERANCE_PCT
          : false,
    },
    ...(outOfSample ? { outOfSample } : {}),
    truncated,
    caveat: splitSample
      ? IN_SAMPLE_CAVEAT
      : `${IN_SAMPLE_CAVEAT} This run had no split-sample check, so the only evidence here is the neighbourhood.`,
  };
}

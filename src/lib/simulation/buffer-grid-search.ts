/**
 * Two-stage grid search planner for the 2D (upper, lower) SMA-buffer parameter space.
 *
 * Stage 1: coarse rectangular grid over the full (upper, lower) range.
 * Stage 2: fine grid centred on the best coarse cell, clipped to the original bounds.
 *
 * The actual simulation runs are handled by `runParallelSimulations`; this module
 * only plans the parameter points and picks the top cell from a set of results.
 */

import type { SmaComparisonRow } from "./types";
import { scoreRow as scoreSmaRow } from "./score";
import { GRID_AXIS_EPSILON, buildAxis } from "./grid-axis";
import { PLATEAU_TOLERANCE, inferSteps, pickPlateauCenter } from "./plateau";

export interface BufferPoint {
  upper: number;
  lower: number;
}

export interface AsymmetricSweepRow extends SmaComparisonRow {
  upperBuffer: number;
  lowerBuffer: number;
  stage: "coarse" | "fine";
}

interface CoarseGridSpec {
  minUpper: number;
  maxUpper: number;
  minLower: number;
  maxLower: number;
  coarseStep: number;
}

interface FineGridSpec {
  centerUpper: number;
  centerLower: number;
  halfWidth: number;
  fineStep: number;
  bounds: {
    minUpper: number;
    maxUpper: number;
    minLower: number;
    maxLower: number;
  };
}

export type ObjectiveKey = "avgRealCagr" | "worstReturn" | "sharpeLike" | "score";

const EPSILON = GRID_AXIS_EPSILON;

export function planCoarseGrid(spec: CoarseGridSpec): BufferPoint[] {
  const uppers = buildAxis(spec.minUpper, spec.maxUpper, spec.coarseStep);
  const lowers = buildAxis(spec.minLower, spec.maxLower, spec.coarseStep);
  const points: BufferPoint[] = [];
  for (const upper of uppers) {
    for (const lower of lowers) {
      points.push({ upper, lower });
    }
  }
  return points;
}

export function planFineGrid(spec: FineGridSpec): BufferPoint[] {
  const minU = Math.max(spec.bounds.minUpper, spec.centerUpper - spec.halfWidth);
  const maxU = Math.min(spec.bounds.maxUpper, spec.centerUpper + spec.halfWidth);
  const minL = Math.max(spec.bounds.minLower, spec.centerLower - spec.halfWidth);
  const maxL = Math.min(spec.bounds.maxLower, spec.centerLower + spec.halfWidth);

  const uppers = buildAxis(minU, maxU, spec.fineStep);
  const lowers = buildAxis(minL, maxL, spec.fineStep);
  const points: BufferPoint[] = [];
  for (const upper of uppers) {
    for (const lower of lowers) {
      points.push({ upper, lower });
    }
  }
  return points;
}

/**
 * De-duplicate a list of (upper, lower) points using a step-rounded key so we
 * don't re-run a coarse cell when planning the fine grid.
 */
export function dedupePoints(
  points: BufferPoint[],
  alreadyEvaluated: BufferPoint[] = []
): BufferPoint[] {
  const seen = new Set<string>();
  const keyFor = (p: BufferPoint) => `${p.upper.toFixed(4)}|${p.lower.toFixed(4)}`;
  for (const p of alreadyEvaluated) seen.add(keyFor(p));
  const out: BufferPoint[] = [];
  for (const p of points) {
    const k = keyFor(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

export function scoreRow(row: AsymmetricSweepRow, key: ObjectiveKey, inflationPct: number): number {
  switch (key) {
    case "avgRealCagr":
      return (row.avgReturn ?? 0) - inflationPct;
    case "worstReturn":
      return row.worstReturn ?? -Infinity;
    case "sharpeLike": {
      const avg = (row.avgReturn ?? 0) - inflationPct;
      const dd = Math.abs(row.biggestMaxDrawdown ?? 0);
      return dd > EPSILON ? avg / dd : avg;
    }
    case "score":
      // Heuristic strategy score used by the main comparison tools — rewards
      // returns, penalises drawdowns and excessive trading.
      return scoreSmaRow(row, inflationPct, row.avgWindowYears ?? 1);
  }
}

/**
 * Pick the (upper, lower) cell to report as best.
 *
 * The middle of the flat region around the top cell, not the top cell — a 0.1%
 * buffer move can halve the score, so the argmax often sits on an edge. Shares
 * `findPlateau` with the sweep pages and the offline calibrator so all three
 * name the same band. Ties inside the plateau fall back to lower upperBuffer
 * then lower lowerBuffer, keeping the old determinism.
 */
export function pickTopCell(
  rows: AsymmetricSweepRow[],
  key: ObjectiveKey,
  inflationPct: number
): AsymmetricSweepRow | null {
  if (rows.length === 0) return null;
  const candidates = rows
    .map((row) => ({
      item: row,
      coords: [row.upperBuffer, row.lowerBuffer],
      score: scoreRow(row, key, inflationPct),
    }))
    .filter((candidate) => isFinite(candidate.score));
  if (candidates.length === 0) return null;
  return (
    pickPlateauCenter(candidates, {
      tolerance: PLATEAU_TOLERANCE,
      steps: inferSteps(candidates, 2),
    }) ?? null
  );
}

export function topK(
  rows: AsymmetricSweepRow[],
  key: ObjectiveKey,
  inflationPct: number,
  k: number
): AsymmetricSweepRow[] {
  return [...rows]
    .map((row) => ({ row, score: scoreRow(row, key, inflationPct) }))
    .filter((x) => isFinite(x.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.row);
}

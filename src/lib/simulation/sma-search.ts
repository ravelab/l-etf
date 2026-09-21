/**
 * Pure geometry for the JOINT (period, upper, lower) SMA search.
 *
 * `buffer-grid-search.ts` searches the 2D buffer plane at a period somebody
 * else already picked. That is the wrong shape for calibration: the best buffer
 * is strongly period-dependent (SPX wants ~3% near 185d and ~9-15% near 40d),
 * so sweeping the period at one fixed buffer and then the buffer at that period
 * is coordinate descent on a surface with no reason to be separable — it lands
 * in whichever basin the fixed starting buffer happened to favour.
 *
 * This module plans a search over all three axes at once. It only plans points
 * and ranks results; running them is the caller's job.
 */

import { GRID_AXIS_EPSILON, buildAxis, roundToStep } from "./grid-axis";

export interface SmaCombo {
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
}

interface BufferBounds {
  minBuffer: number;
  maxBuffer: number;
}

interface PeriodBounds {
  minPeriod: number;
  maxPeriod: number;
}

/** Stable key for a combo, rounded so float drift can't create a duplicate. */
export function comboKey(combo: SmaCombo): string {
  return [
    Math.round(combo.smaPeriod),
    combo.smaUpperBuffer.toFixed(4),
    combo.smaLowerBuffer.toFixed(4),
  ].join("|");
}

/** Every integer period in `[center - halfWidth, center + halfWidth]`, clamped. */
export function planPeriodNeighborhood(
  center: number,
  halfWidth: number,
  bounds: PeriodBounds
): number[] {
  const lo = Math.max(bounds.minPeriod, Math.round(center - halfWidth));
  const hi = Math.min(bounds.maxPeriod, Math.round(center + halfWidth));
  const out: number[] = [];
  for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

/** The (upper, lower) square of side `2 * halfWidth` around a centre, clamped. */
export function planBufferNeighborhood(
  centerUpper: number,
  centerLower: number,
  halfWidth: number,
  step: number,
  bounds: BufferBounds
): Array<{ upper: number; lower: number }> {
  const uppers = buildAxis(
    Math.max(bounds.minBuffer, roundToStep(centerUpper - halfWidth, step)),
    Math.min(bounds.maxBuffer, roundToStep(centerUpper + halfWidth, step)),
    step
  );
  const lowers = buildAxis(
    Math.max(bounds.minBuffer, roundToStep(centerLower - halfWidth, step)),
    Math.min(bounds.maxBuffer, roundToStep(centerLower + halfWidth, step)),
    step
  );
  const out: Array<{ upper: number; lower: number }> = [];
  for (const upper of uppers) {
    for (const lower of lowers) out.push({ upper, lower });
  }
  return out;
}

/**
 * Cross a period list with a buffer-point list into combos, dropping any combo
 * already evaluated. Every stage of the search re-centres on points earlier
 * stages produced, so without this the later stages spend most of their budget
 * recomputing cells they already have.
 */
export function planCombos(
  periods: number[],
  bufferPoints: Array<{ upper: number; lower: number }>,
  seen: Set<string>
): SmaCombo[] {
  const crossed: SmaCombo[] = [];
  for (const smaPeriod of periods) {
    for (const { upper, lower } of bufferPoints) {
      crossed.push({ smaPeriod, smaUpperBuffer: upper, smaLowerBuffer: lower });
    }
  }
  return dedupeCombos(crossed, seen);
}

/** Drop combos an earlier stage already evaluated, recording the rest as seen. */
export function dedupeCombos(combos: SmaCombo[], seen: Set<string>): SmaCombo[] {
  const out: SmaCombo[] = [];
  for (const combo of combos) {
    const key = comboKey(combo);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(combo);
  }
  return out;
}

export interface ScoredCombo {
  combo: SmaCombo;
  score: number;
}

/**
 * Best `count` results, but no two within `minPeriodSeparation` days of each
 * other. The score surface is spiky in the period axis, so a plain top-N is
 * almost always N adjacent points on one spike; separating them makes the next
 * stage open up N genuinely different basins instead.
 */
export function pickTopDistinctPeriods<T extends ScoredCombo>(
  scored: T[],
  count: number,
  minPeriodSeparation: number
): T[] {
  const ranked = [...scored]
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.combo.smaPeriod - b.combo.smaPeriod);
  const chosen: T[] = [];
  for (const entry of ranked) {
    if (chosen.length >= count) break;
    const tooClose = chosen.some(
      (other) => Math.abs(other.combo.smaPeriod - entry.combo.smaPeriod) < minPeriodSeparation
    );
    if (tooClose) continue;
    chosen.push(entry);
  }
  return chosen;
}

/** Best `count` results outright, ties broken toward the shorter period. */
export function pickTop<T extends ScoredCombo>(scored: T[], count: number): T[] {
  return [...scored]
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.combo.smaPeriod - b.combo.smaPeriod)
    .slice(0, count);
}

/**
 * Every result whose score is indistinguishable from the best, within a
 * RELATIVE tolerance. Two combos that trade identically over the whole history
 * score identically up to float noise — SPX 30d -6.1%/+8% and 31d -6%/+8%
 * differ by 5e-12 — and ranking those by raw score picks between them at
 * random. Returned best-first; empty only when nothing scored finitely.
 */
export function findScoreTies<T extends ScoredCombo>(scored: T[], relTolerance: number): T[] {
  const ranked = [...scored]
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score || a.combo.smaPeriod - b.combo.smaPeriod);
  if (ranked.length === 0) return [];
  const best = ranked[0].score;
  const floor = best - Math.abs(best) * relTolerance;
  return ranked.filter((entry) => entry.score >= floor);
}

/**
 * Thin a tie set so it spans distinct periods instead of one period's buffer
 * variants. A plateau ties on score at many nearby buffers, so a plain
 * head-of-list cap fills entirely with 30d-something and never considers the
 * equally-scoring 31d — which is the alternative most likely to have a
 * different, safer neighbourhood.
 */
export function limitTiesPerPeriod<T extends ScoredCombo>(
  ties: T[],
  perPeriod: number,
  total: number
): T[] {
  const takenByPeriod = new Map<number, number>();
  const out: T[] = [];
  for (const tie of ties) {
    if (out.length >= total) break;
    const taken = takenByPeriod.get(tie.combo.smaPeriod) ?? 0;
    if (taken >= perPeriod) continue;
    takenByPeriod.set(tie.combo.smaPeriod, taken + 1);
    out.push(tie);
  }
  return out;
}

interface PlateauStats {
  /** How many one-step neighbours of the winner were evaluated. */
  neighborCount: number;
  /** Worst score among them — a knife-edge optimum has a far lower one. */
  minScore: number;
  medianScore: number;
}

/**
 * Describe the winner's immediate surroundings. A top score whose neighbours
 * collapse is an artifact of the sample, not a rule you can run next year; the
 * calibration records this so the spike is visible instead of implicit.
 * `periodStep` / `bufferStep` define what "one step away" means.
 */
export function summarizePlateau(
  winner: SmaCombo,
  scored: ScoredCombo[],
  periodStep: number,
  bufferStep: number
): PlateauStats {
  const neighbors: number[] = [];
  for (const entry of scored) {
    if (!Number.isFinite(entry.score)) continue;
    const dp = Math.abs(entry.combo.smaPeriod - winner.smaPeriod);
    const du = Math.abs(entry.combo.smaUpperBuffer - winner.smaUpperBuffer);
    const dl = Math.abs(entry.combo.smaLowerBuffer - winner.smaLowerBuffer);
    if (dp < GRID_AXIS_EPSILON && du < GRID_AXIS_EPSILON && dl < GRID_AXIS_EPSILON) continue;
    if (
      dp <= periodStep + GRID_AXIS_EPSILON &&
      du <= bufferStep + GRID_AXIS_EPSILON &&
      dl <= bufferStep + GRID_AXIS_EPSILON
    ) {
      neighbors.push(entry.score);
    }
  }
  if (neighbors.length === 0) {
    return { neighborCount: 0, minScore: Number.NaN, medianScore: Number.NaN };
  }
  neighbors.sort((a, b) => a - b);
  const mid = Math.floor(neighbors.length / 2);
  const medianScore =
    neighbors.length % 2 === 0 ? (neighbors[mid - 1] + neighbors[mid]) / 2 : neighbors[mid];
  return { neighborCount: neighbors.length, minScore: neighbors[0], medianScore };
}

/**
 * Among combos that score the same, prefer the one that is not on a cliff:
 * rank by the WORST immediate neighbour, then the median, then the shorter
 * period. This never overrules the score — `candidates` are already tied on it
 * — it just replaces a float-noise tie-break with a meaningful one. Candidates
 * whose neighbourhood was never evaluated rank last, since nothing is known
 * about them.
 */
export function pickMostStable<T extends ScoredCombo>(
  candidates: T[],
  scored: ScoredCombo[],
  periodStep: number,
  bufferStep: number
): T {
  if (candidates.length === 0) throw new Error("pickMostStable needs at least one candidate");
  const rank = (candidate: T) => {
    const stats = summarizePlateau(candidate.combo, scored, periodStep, bufferStep);
    return {
      candidate,
      minScore: Number.isFinite(stats.minScore) ? stats.minScore : -Infinity,
      medianScore: Number.isFinite(stats.medianScore) ? stats.medianScore : -Infinity,
    };
  };
  return candidates
    .map(rank)
    .sort(
      (a, b) =>
        b.minScore - a.minScore ||
        b.medianScore - a.medianScore ||
        a.candidate.combo.smaPeriod - b.candidate.combo.smaPeriod
    )[0].candidate;
}

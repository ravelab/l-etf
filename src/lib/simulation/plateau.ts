/**
 * Pick the MIDDLE of the flat region around the best point, not the best point.
 *
 * Every search here reports a winner off a spiky surface, and the raw argmax
 * routinely lands on the edge of a cliff. The measured NDX case: periods
 * 125, 126 and 127 all score 18,050 while 128 scores 8,780, so reporting 127
 * puts the shipped rule one step from a 2.1x drop for no gain over 126. The
 * same holds on the buffer axes, where a 0.1% move can halve the score.
 *
 * So: take the points whose score is within `tolerance` of the best, keep the
 * CONNECTED region containing the best point, and return the member closest to
 * that region's centre. Connectivity is what stops a centroid being computed
 * across two separate basins and landing in the valley between them — a point
 * that is in neither.
 *
 * Pure and dimension-agnostic: the sweep pages hand it 1-D rows (period, or one
 * buffer) and the 2-D buffer grid, the calibrator hands it 3-D
 * (period, upper, lower). Nothing here simulates; the caller supplies scored
 * points and the grid spacing that defines "adjacent".
 */

export interface PlateauCandidate<T> {
  item: T;
  /** Position on each search axis, in that axis's own units. */
  coords: number[];
  score: number;
}

interface PlateauOptions {
  /**
   * How far below the best score still counts as "the same height", as a
   * fraction of the best score's magnitude. 0.02 was chosen against the real
   * surface: it holds NDX's {125,126,127} and SPX's {173,174,175} together
   * while keeping out NDX's 121-124 shelf, which is a genuine 3.6% lower.
   */
  tolerance: number;
  /**
   * Grid spacing per axis. Two points are adjacent when they are within one
   * step on EVERY axis, so diagonals count — a plateau is not disconnected by
   * a staircase edge.
   */
  steps: number[];
  /** Absolute floor for the tolerance band, for surfaces that score near zero. */
  minAbsoluteTolerance?: number;
}

interface PlateauResult<T> {
  /** The member closest to the plateau's centre. */
  center: PlateauCandidate<T>;
  /** The best-scoring member — what an argmax would have returned. */
  peak: PlateauCandidate<T>;
  /** Every member of the connected flat region, including the peak. */
  members: PlateauCandidate<T>[];
  /** Per-axis extent of the region, in axis units. */
  widths: number[];
}

const EPSILON = 1e-9;

/**
 * Element-wise numeric comparison, for deterministic tie-breaks. A string
 * compare of joined coords would order "10" before "9".
 */
function compareCoords(a: number[], b: number[]): number {
  for (let axis = 0; axis < Math.min(a.length, b.length); axis++) {
    if (a[axis] < b[axis] - EPSILON) return -1;
    if (a[axis] > b[axis] + EPSILON) return 1;
  }
  return 0;
}

function isAdjacent(a: number[], b: number[], steps: number[]): boolean {
  for (let axis = 0; axis < steps.length; axis++) {
    if (Math.abs(a[axis] - b[axis]) > steps[axis] + EPSILON) return false;
  }
  return true;
}

/**
 * Infer each axis's grid spacing from the points themselves: the smallest
 * positive gap seen on that axis. Sweep pages choose their own step sizes at
 * runtime, so hard-coding one here would silently disconnect a coarse sweep
 * into singletons.
 */
export function inferSteps<T>(candidates: PlateauCandidate<T>[], axisCount: number): number[] {
  const steps: number[] = [];
  for (let axis = 0; axis < axisCount; axis++) {
    const values = [...new Set(candidates.map((c) => c.coords[axis]))].sort((a, b) => a - b);
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < values.length; i++) {
      const gap = values[i] - values[i - 1];
      if (gap > EPSILON && gap < smallest) smallest = gap;
    }
    steps.push(Number.isFinite(smallest) ? smallest : 1);
  }
  return steps;
}

/**
 * The connected set of near-best points containing the peak, and its centre.
 * Returns null only when given nothing scoreable.
 */
export function findPlateau<T>(
  candidates: PlateauCandidate<T>[],
  options: PlateauOptions
): PlateauResult<T> | null {
  const scoreable = candidates.filter((c) => Number.isFinite(c.score));
  if (scoreable.length === 0) return null;

  // Lowest coords win a tie for the peak. Without this the peak — and so the
  // whole region flood-filled from it — would depend on the order the caller
  // built the array in, which for two equal, NON-adjacent cells means two
  // different answers for the same data.
  let peak = scoreable[0];
  for (const candidate of scoreable) {
    if (
      candidate.score > peak.score + EPSILON ||
      (Math.abs(candidate.score - peak.score) <= EPSILON &&
        compareCoords(candidate.coords, peak.coords) < 0)
    ) {
      peak = candidate;
    }
  }

  const band = Math.max(
    Math.abs(peak.score) * options.tolerance,
    options.minAbsoluteTolerance ?? 0
  );
  const floor = peak.score - band;
  const eligible = scoreable.filter((c) => c.score >= floor);

  // Flood-fill outward from the peak so a same-height region that is NOT
  // reachable from it cannot pull the centre away.
  const members: PlateauCandidate<T>[] = [];
  const queue: PlateauCandidate<T>[] = [peak];
  const claimed = new Set<PlateauCandidate<T>>([peak]);
  while (queue.length > 0) {
    const current = queue.shift() as PlateauCandidate<T>;
    members.push(current);
    for (const candidate of eligible) {
      if (claimed.has(candidate)) continue;
      if (!isAdjacent(current.coords, candidate.coords, options.steps)) continue;
      claimed.add(candidate);
      queue.push(candidate);
    }
  }

  const axisCount = options.steps.length;
  const centroid: number[] = [];
  const widths: number[] = [];
  for (let axis = 0; axis < axisCount; axis++) {
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const member of members) {
      sum += member.coords[axis];
      min = Math.min(min, member.coords[axis]);
      max = Math.max(max, member.coords[axis]);
    }
    centroid.push(sum / members.length);
    widths.push(max - min);
  }

  // Closest member to the centroid, measured in grid steps so axes with very
  // different units (a period of 127 vs a buffer of 17.8) weigh the same.
  // Ties go to the higher score, then to the lower coordinates, so the result
  // never depends on the order the caller happened to build the list in.
  let center = members[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const member of members) {
    let distance = 0;
    for (let axis = 0; axis < axisCount; axis++) {
      const delta = (member.coords[axis] - centroid[axis]) / Math.max(EPSILON, options.steps[axis]);
      distance += delta * delta;
    }
    if (
      distance < bestDistance - EPSILON ||
      (Math.abs(distance - bestDistance) <= EPSILON &&
        (member.score > center.score + EPSILON ||
          (Math.abs(member.score - center.score) <= EPSILON &&
            compareCoords(member.coords, center.coords) < 0)))
    ) {
      center = member;
      bestDistance = distance;
    }
  }

  return { center, peak, members, widths };
}

/** Convenience for the common case: just the item at the plateau's centre. */
export function pickPlateauCenter<T>(
  candidates: PlateauCandidate<T>[],
  options: PlateauOptions
): T | null {
  return findPlateau(candidates, options)?.center.item ?? null;
}

/** Default tolerance for every caller, so the UI and the calibrator agree. */
export const PLATEAU_TOLERANCE = 0.02;

export type AdjustedOverlapPair = {
  date: string;
  stored: number;
  fresh: number;
};

// Relative tolerances. Stored CSV adj_closes are typically rounded to a few
// decimals while Tiingo returns full float precision, so day-to-day
// fresh/stored ratios can scatter by ~1e-6 even when nothing was re-stated.
// Keep these loose enough to absorb that noise, but tight enough that a real
// single-row correction (or a genuine non-uniform rewrite) still throws.
const MATCH_TOLERANCE = 1e-6;
const RATIO_CONSISTENCY_TOLERANCE = 1e-5;

function nearlyEqual(a: number, b: number, tolerance: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerance * scale;
}

/**
 * Detects a uniform re-adjustment (dividend/split) between stored and freshly
 * fetched adjusted closes over an overlap window.
 *
 * Providers like Tiingo re-state every historical adjusted close by one
 * common factor whenever a dividend or split occurs; stored rows older than
 * the fresh window must then be scaled by that same factor to keep the series
 * chained. A non-uniform disagreement is not a re-adjustment — it means the
 * provider corrected or corrupted individual rows, so we refuse to guess.
 *
 * @returns null when the overlap matches (no rebase needed), otherwise the
 *   uniform fresh/stored ratio to apply to rows outside the fresh window.
 * @throws when the overlap disagrees non-uniformly.
 */
export function computeAdjustedRebaseRatio(pairs: AdjustedOverlapPair[]): number | null {
  const usable = pairs.filter(
    (pair) =>
      Number.isFinite(pair.stored) &&
      Number.isFinite(pair.fresh) &&
      pair.stored > 0 &&
      pair.fresh > 0
  );
  if (usable.length === 0) return null;

  if (usable.every((pair) => nearlyEqual(pair.stored, pair.fresh, MATCH_TOLERANCE))) {
    return null;
  }

  const ratios = usable.map((pair) => pair.fresh / pair.stored);
  const reference = ratios[0];
  const inconsistentIndex = ratios.findIndex(
    (ratio) => !nearlyEqual(ratio, reference, RATIO_CONSISTENCY_TOLERANCE)
  );
  if (inconsistentIndex >= 0) {
    const pair = usable[inconsistentIndex];
    throw new Error(
      `Adjusted closes shifted non-uniformly across the overlap ` +
        `(${usable[0].date} ratio ${reference.toFixed(8)} vs ${pair.date} ratio ${ratios[inconsistentIndex].toFixed(8)})`
    );
  }

  return reference;
}

/**
 * Inclusive numeric axis builder shared by every grid search in this codebase
 * (`buffer-grid-search.ts`'s 2D buffer grid and `sma-search.ts`'s joint
 * period x buffer search). It lives on its own because both need identical
 * step-rounding: a second copy would let two searches disagree about whether
 * 3.3000000000000003 and 3.3 are the same grid point.
 */

const EPSILON = 1e-9;

/**
 * Round to the number of decimals the step implies, so accumulated float drift
 * never turns one grid point into two.
 */
export function roundToStep(value: number, step: number): number {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.max(0, Math.ceil(-Math.log10(step))) + 1);
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function dedupeSorted(sorted: number[]): number[] {
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(out[out.length - 1] - v) > EPSILON) {
      out.push(v);
    }
  }
  return out;
}

/** Inclusive `[min, max]` axis at `step`, always containing the upper bound. */
export function buildAxis(min: number, max: number, step: number): number[] {
  if (!isFinite(min) || !isFinite(max) || !isFinite(step) || step <= 0) {
    return [];
  }
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const values: number[] = [];
  for (let v = lo; v <= hi + EPSILON; v += step) {
    values.push(roundToStep(v, step));
  }
  // Always include the upper bound if floating drift kept it out.
  const last = values[values.length - 1];
  if (last === undefined || last < hi - EPSILON) {
    values.push(roundToStep(hi, step));
  }
  return dedupeSorted(values);
}

export const GRID_AXIS_EPSILON = EPSILON;

import type { SmaComparisonRow } from "./types";

type ScoreOptions = {
  /** When true, use the heavier drawdown-penalty exponent. */
  hateDrawdown?: boolean;
};

/**
 * Core score from inputs that are already **real** (inflation-adjusted):
 * - avgRealCagr / worstRealCagr: average and worst rolling real CAGR (%).
 * Drawdowns are nominal path metrics (not inflation series).
 *
 * Simple linear equation: rewards returns and CAGR, penalizes drawdowns and excess trades.
 */
function computeScore(
  avgRealCagr: number,
  worstRealCagr: number,
  avgMaxDrawdown: number,
  biggestMaxDrawdown: number,
  avgTradesPerYear: number,
  options: ScoreOptions = {},
): number {
  const signedPow = (value: number, exp: number) =>
    Math.sign(value) * Math.pow(Math.abs(value), exp);

  // Allow negative CAGRs without producing NaN (fractional exponent).
  const returnScore = signedPow(avgRealCagr, 2.9) + worstRealCagr * 9;

  const avgDrawdownExponent = options.hateDrawdown ? 2.5 : 1.7;
  const drawdownPenalty =
    Math.pow(avgMaxDrawdown, avgDrawdownExponent) + biggestMaxDrawdown * 1;

  // Heavy penalty for drawdowns exceeding 80% (buy-and-hold leveraged ETFs)
  const capitulationPenalty =
    biggestMaxDrawdown > 80 ? Math.pow(biggestMaxDrawdown - 80, 4.0) : 0;

  // Penalize frequent trading super-linearly so infrequent traders (≤1/yr) are
  // barely dinged while frequent traders (≥5/yr) pay a steep cost.
  const tradePenalty = Math.pow(Math.max(0, avgTradesPerYear), 7.0);

  return returnScore - drawdownPenalty - capitulationPenalty - tradePenalty;
}

/**
 * Score a comparison row. Matches table pages: when `inflationPct` is 0, `row` is treated as
 * already real (per-window CPI in `summarizeSmaRow`). When `inflationPct` > 0, nominal CAGRs in
 * the row are converted with that annual rate so the score uses the same real CAGRs as the UI.
 */
export function scoreRow(
  row: SmaComparisonRow,
  inflationPct: number,
  windowYears = 1,
  options: ScoreOptions = {},
): number {
  const avgRealCagr = inflationPct > 0 ? row.avgReturn - inflationPct : row.avgReturn;
  const worstRealCagr = inflationPct > 0 ? row.worstReturn - inflationPct : row.worstReturn;
  // avgTrades is per window; score uses trades/year for comparability across window sizes.
  const avgTradesPerYear = row.avgTrades / Math.max(1e-9, windowYears);

  return computeScore(
    avgRealCagr,
    worstRealCagr,
    row.avgMaxDrawdown,
    row.biggestMaxDrawdown,
    avgTradesPerYear,
    options,
  );
}

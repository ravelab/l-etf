import type { SmaComparisonRow } from "./types";

type ScoreOptions = {
  /** When true, use the heavier drawdown-penalty exponent. */
  hateDrawdown?: boolean;
};

// Counts individual risk-on/off switches, not complete exit/re-entry cycles.
const TARGET_TRADES_PER_YEAR = 0.5;
const SPARSE_TRADING_PENALTY_WEIGHT = 8000;
const FREQUENT_TRADING_PENALTY_WEIGHT = 3000;
const ABOVE_TARGET_PENALTY_WEIGHT = 400;

function tradingFrequencyPenalty(avgTradesPerYear: number): number {
  const frequency = Math.max(0, avgTradesPerYear);
  // The minimum penalty is at 0.5/year; one switch/year has a modest penalty.
  // A zero-trade strategy has a finite penalty, so this remains a preference
  // rather than excluding buy-and-hold regardless of its other metrics.
  const sparseDistance = Math.max(0, (TARGET_TRADES_PER_YEAR - frequency) / TARGET_TRADES_PER_YEAR);
  const aboveTargetDistance = Math.max(0, frequency - TARGET_TRADES_PER_YEAR);
  const frequentDistance = Math.max(0, frequency - 1);
  const frequencyPenalty = SPARSE_TRADING_PENALTY_WEIGHT * sparseDistance ** 2
    + ABOVE_TARGET_PENALTY_WEIGHT * aboveTargetDistance ** 2
    + FREQUENT_TRADING_PENALTY_WEIGHT * frequentDistance ** 2;
  // Retain the existing steep protection against extreme trading frequency,
  // beyond one switch/year.
  const excessiveTradingPenalty = Math.max(0, frequency ** 7 - 1);
  return frequencyPenalty + excessiveTradingPenalty;
}

/**
 * Core score from inputs that are already **real** (inflation-adjusted):
 * - avgRealCagr / worstRealCagr: average and worst rolling real CAGR (%).
 * Drawdowns are nominal path metrics (not inflation series).
 *
 * Rewards returns and CAGR, penalizes drawdowns and deviations from 0.5 switches/year.
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

  const tradePenalty = tradingFrequencyPenalty(avgTradesPerYear);

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

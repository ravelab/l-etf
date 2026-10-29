/**
 * The one definition of the SMA parameter box. The exhaustive explorer
 * (`scripts/explore-sma-space.ts`) and the monthly calibrator
 * (`scripts/calibrate-sma.ts`) must search the same box, or the seeds the
 * first writes would sit outside the range the second is allowed to pick from.
 */

export const SMA_SEARCH_MIN_PERIOD = 50;
export const SMA_SEARCH_MAX_PERIOD = 280;
export const SMA_SEARCH_MIN_BUFFER = 0;
export const SMA_SEARCH_MAX_BUFFER = 21;

/**
 * Once risk-off, a rule re-enters only when the index closes `upper`% above its
 * SMA. On a steady climb at annual rate g the SMA trails price by about
 * (period-1)/2 trading days, so the band is reached only if
 * (1+g)^((period-1)/2/252) > 1 + upper/100. History rewards wide re-entry bands
 * because its recoveries were mostly V-shaped (NDX 107d +16.4% needs ~106%/yr
 * and sat out 1987-1991 while NDX rose 41%), so past a strong ordinary bull
 * year every 2 points of required climb cost 1% of each era's score.
 */
export const SMA_REENTRY_PENALTY = { freeClimbPct: 60, climbPctPerScorePct: 2 };

/** Steady annual climb (%) needed to cross the re-entry band. */
export function smaReentryClimbPct(combo: { smaPeriod: number; smaUpperBuffer: number }): number {
  const lagYears = (combo.smaPeriod - 1) / 2 / 252;
  return (Math.exp(Math.log(1 + combo.smaUpperBuffer / 100) / lagYears) - 1) * 100;
}

/** Share of |score| an era loses for a re-entry band a steady climb rarely reaches. */
export function smaReentryPenaltyFraction(combo: { smaPeriod: number; smaUpperBuffer: number }): number {
  const excess = Math.max(0, smaReentryClimbPct(combo) - SMA_REENTRY_PENALTY.freeClimbPct);
  return Math.min(1, excess / SMA_REENTRY_PENALTY.climbPctPerScorePct / 100);
}

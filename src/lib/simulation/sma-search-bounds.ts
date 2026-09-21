/**
 * The one definition of the SMA parameter box. The exhaustive explorer
 * (`scripts/explore-sma-space.ts`) and the monthly calibrator
 * (`scripts/calibrate-sma.ts`) must search the same box, or the seeds the
 * first writes would sit outside the range the second is allowed to pick from.
 */

export const SMA_SEARCH_MIN_PERIOD = 20;
export const SMA_SEARCH_MAX_PERIOD = 280;
export const SMA_SEARCH_MIN_BUFFER = 0;
export const SMA_SEARCH_MAX_BUFFER = 21;

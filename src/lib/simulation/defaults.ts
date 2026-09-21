/**
 * Default SMA rule per index, as an ASYMMETRIC band — upper governs re-entry,
 * lower governs the exit. Never collapse these back to one number used for both
 * sides: doing exactly that to the futures ladder moved the trapdoor rather than
 * the band and rode 1973-74 down 91.5% where its LETF twin stopped at 65.9%
 * (see the futures-plan notes in AGENTS.md).
 *
 * These are a hand-refreshed copy of the last `npm run calibrate-sma` result
 * (`src/lib/tool-snapshots/sma-calibration.json`), which is scored across every
 * range in `sma-calibration-eras.ts`. They are what an input box starts at and
 * what an MCP caller gets when it omits the parameter; the push alerts do NOT
 * read them — those follow the calibration snapshot itself, which the monthly
 * build refreshes. So these drift from the snapshot between refreshes, and that
 * is fine; re-sync them when a calibration moves materially.
 */
const DEFAULT_SMA_BANDS = {
  sp500: { period: 174, upperBuffer: 3.5, lowerBuffer: 3.6 },
  nasdaq100: { period: 127, upperBuffer: 19.3, lowerBuffer: 17.8 },
} as const satisfies Record<"sp500" | "nasdaq100", { period: number; upperBuffer: number; lowerBuffer: number }>;

const DEFAULT_PERIOD_YEARS = 10;

export const DEFAULT_RISK_OFF_ASSET = "BRK.B+GLDM+VGSH" as const;

export const DEFAULT_FUTURES_AMOUNT = 100_000;

/**
 * Band around target leverage: skip routine resizes while |Δ| stays within ±this %,
 * and skip resizes whose projected improvement in |Δ| is below this threshold
 * (reduces oscillation across the target).
 *
 * Futures: the open-session max-leverage trim also uses this as headroom — a peel
 * runs only when open leverage exceeds `maxLeverage * (1 + this/100)`, so the same
 * knob widens the dead band vs target and delays trims when `maxLeverage` is tight.
 */
export const DEFAULT_LEVERAGE_TOLERANCE_PCT = 1;

/** Convenience: pick the right default SMA period for a given index. */
export function getDefaultSmaPeriod(index: "sp500" | "nasdaq100"): number {
  return DEFAULT_SMA_BANDS[index].period;
}

/** Default re-entry threshold, percent above the SMA. */
export function getDefaultSmaUpperBuffer(index: "sp500" | "nasdaq100"): number {
  return DEFAULT_SMA_BANDS[index].upperBuffer;
}

/** Default exit threshold, percent below the SMA. */
export function getDefaultSmaLowerBuffer(index: "sp500" | "nasdaq100"): number {
  return DEFAULT_SMA_BANDS[index].lowerBuffer;
}

export function getDefaultWindowLength(): number {
  return DEFAULT_PERIOD_YEARS;
}

import calibration from "../tool-snapshots/sma-calibration.json";

/**
 * Default SMA rule per index, as an ASYMMETRIC band — upper governs re-entry,
 * lower governs the exit. Never collapse these back to one number used for both
 * sides: doing exactly that to the futures ladder moved the trapdoor rather than
 * the band and rode 1973-74 down 91.5% where its LETF twin stopped at 65.9%
 * (see the futures-plan notes in AGENTS.md).
 *
 * Read the last `npm run calibrate-sma` result directly so input defaults,
 * omitted MCP parameters, and calibrated push alerts share the same band.
 * The monthly build refreshes the snapshot before bundling the app. Importing
 * JSON keeps this module safe for both browser and server callers.
 */
const DEFAULT_SMA_BANDS = {
  sp500: { period: calibration.sp500.smaPeriod, upperBuffer: calibration.sp500.smaUpperBuffer, lowerBuffer: calibration.sp500.smaLowerBuffer },
  nasdaq100: { period: calibration.nasdaq100.smaPeriod, upperBuffer: calibration.nasdaq100.smaUpperBuffer, lowerBuffer: calibration.nasdaq100.smaLowerBuffer },
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

const DEFAULT_SMA_SP500_PERIOD = 185;
const DEFAULT_SMA_NASDAQ_PERIOD = 150;
const DEFAULT_SMA_SP500_BUFFER = 3.6;
const DEFAULT_SMA_NASDAQ_BUFFER = 11.9;
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
  return index === "nasdaq100" ? DEFAULT_SMA_NASDAQ_PERIOD : DEFAULT_SMA_SP500_PERIOD;
}

/** Convenience: pick the right default SMA buffer for a given index. */
export function getDefaultSmaBuffer(index: "sp500" | "nasdaq100"): number {
  return index === "nasdaq100" ? DEFAULT_SMA_NASDAQ_BUFFER : DEFAULT_SMA_SP500_BUFFER;
}

export function getDefaultWindowLength(): number {
  return DEFAULT_PERIOD_YEARS;
}

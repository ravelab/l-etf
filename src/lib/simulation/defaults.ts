import calibration from "../tool-snapshots/sma-calibration.json";
import inflationCalibration from "../tool-snapshots/sma-calibration-inflation.json";
import type { IndexKey, RiskOffAsset } from "./types";

/**
 * Default SMA rule per index, as an ASYMMETRIC band — upper governs re-entry,
 * lower governs the exit. Calibration may choose equal numerical values.
 * Never collapse the separate fields back to one number used for both
 * sides: doing exactly that to the futures ladder moved the trapdoor rather than
 * the band and rode 1973-74 down 91.5% where its LETF twin stopped at 65.9%
 * (see the futures-plan notes in AGENTS.md).
 *
 * Read the last `npm run calibrate-sma` result (nominal set) directly so the
 * engine's preset fallback and omitted MCP parameters share the nominal band; the
 * site's inputs default to `getSiteDefaultSmaRule` below. The monthly build
 * refreshes both snapshots before bundling the app. Importing JSON keeps this
 * module safe for both browser and server callers.
 */
const DEFAULT_SMA_BANDS = {
  sp500: { period: calibration.sp500.smaPeriod, upperBuffer: calibration.sp500.smaUpperBuffer, lowerBuffer: calibration.sp500.smaLowerBuffer },
  nasdaq100: { period: calibration.nasdaq100.smaPeriod, upperBuffer: calibration.nasdaq100.smaUpperBuffer, lowerBuffer: calibration.nasdaq100.smaLowerBuffer },
} as const satisfies Record<"sp500" | "nasdaq100", { period: number; upperBuffer: number; lowerBuffer: number }>;

const DEFAULT_PERIOD_YEARS = 10;

export const DEFAULT_RISK_OFF_ASSET = "BRK.B+GLDM+VGSH" as const;

/**
 * What each index's strategies hold while risk-off on the tool pages, and the futures
 * ladder's sleeves, unless the visitor picks otherwise. The SMA calibration scores each
 * index on its entry here; the MCP tools' single `riskOffAsset` still defaults to
 * `DEFAULT_RISK_OFF_ASSET`.
 */
export const DEFAULT_RISK_OFF_ASSETS = {
  sp500: "BRK.B+GLDM",
  nasdaq100: "VGSH",
} as const satisfies Record<IndexKey, RiskOffAsset>;

/** Whether the volatility risk-off gate (`vol-gate.ts`) is on when nobody chose. */
export const DEFAULT_SMA_VOL_GATE = true;

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
export const DEFAULT_LEVERAGE_TOLERANCE_PCT = 9;

/**
 * Futures page, its canned snapshot and the MCP futures tools carry each sleeve's
 * remainder in MES/MNQ by default. The engine's own default stays full-size, so
 * analytical callers that omit `microFutures` are unchanged.
 */
export const DEFAULT_MICRO_FUTURES = true;

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

/**
 * The site's default SMA rule runs the band on the CPI-deflated index ("SMA buffer
 * inflation adjusted" on) with the inflation-adjusted calibration's band. A band only
 * means what it was scored with, so the flag and the band always travel together:
 * read both through `getSiteDefaultSmaRule`.
 *
 * `getDefaultSmaPeriod` / `...UpperBuffer` / `...LowerBuffer` above stay the NOMINAL
 * calibration: the engine's preset fallback and every MCP tool, whose schemas have no
 * inflation flag and therefore always run nominal.
 */
export const DEFAULT_SMA_INFLATION_ADJUSTED = true;

/** The calibration snapshot set the site defaults to. */
export const DEFAULT_SMA_CALIBRATION_VARIANT = DEFAULT_SMA_INFLATION_ADJUSTED ? "inflation" : "nominal";

export interface SiteDefaultSmaRule {
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  smaInflationAdjusted: boolean;
}

/** The site's default band for an index together with the inflation flag it was scored with. */
export function getSiteDefaultSmaRule(index: "sp500" | "nasdaq100"): SiteDefaultSmaRule {
  const band = DEFAULT_SMA_INFLATION_ADJUSTED
    ? getInflationAdjustedDefaultSmaBand(index)
    : { smaPeriod: getDefaultSmaPeriod(index), smaUpperBuffer: getDefaultSmaUpperBuffer(index), smaLowerBuffer: getDefaultSmaLowerBuffer(index) };
  return { ...band, smaInflationAdjusted: DEFAULT_SMA_INFLATION_ADJUSTED };
}

/**
 * The inflation-adjusted calibration's band (`sma-calibration-inflation.json`): the
 * band to use with "SMA buffer inflation adjusted" on.
 */
export function getInflationAdjustedDefaultSmaBand(index: "sp500" | "nasdaq100"): {
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
} {
  const band = inflationCalibration[index];
  return { smaPeriod: band.smaPeriod, smaUpperBuffer: band.smaUpperBuffer, smaLowerBuffer: band.smaLowerBuffer };
}

export function getDefaultWindowLength(): number {
  return DEFAULT_PERIOD_YEARS;
}

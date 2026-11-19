// The SMA calibration keeps two artifact sets: the nominal band (`sma-calibration.json`,
// `sma-cagr-presets.json`, `sma-search-space.json`) and the inflation-adjusted band, run on
// the CPI-deflated index (`*-inflation.json`). The Signals page offers both; the
// "SMA buffer inflation adjusted" checkbox says which one a run uses.
//
// Calibration scripts pick the set from `SMA_CALIBRATION_VARIANT=inflation` (child
// processes and forked workers inherit it); everything else names a variant explicitly.

export type SmaCalibrationVariant = "nominal" | "inflation";

export type SmaArtifactBase = "sma-calibration" | "sma-cagr-presets" | "sma-search-space";

/** The variant a calibration script runs, from its environment. */
export function smaCalibrationVariantFromEnv(): SmaCalibrationVariant {
  return process.env.SMA_CALIBRATION_VARIANT === "inflation" ? "inflation" : "nominal";
}

export function smaArtifactFileName(base: SmaArtifactBase, variant: SmaCalibrationVariant): string {
  return variant === "inflation" ? `${base}-inflation.json` : `${base}.json`;
}

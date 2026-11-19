// Read and locate the calibration artifacts of the variant this script runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { smaArtifactFileName, smaCalibrationVariantFromEnv, type SmaArtifactBase } from "../../src/lib/sma-calibration-variant";
import type nominalCalibration from "../../src/lib/tool-snapshots/sma-calibration.json";
import type nominalPresets from "../../src/lib/tool-snapshots/sma-cagr-presets.json";
import type nominalSearchSpace from "../../src/lib/tool-snapshots/sma-search-space.json";

const SMA_VARIANT = smaCalibrationVariantFromEnv();

export function smaArtifactPath(base: SmaArtifactBase): string {
  return join(process.cwd(), "src", "lib", "tool-snapshots", smaArtifactFileName(base, SMA_VARIANT));
}

/** Both variants share the nominal files' shape. */
type ArtifactShape = {
  "sma-calibration": typeof nominalCalibration;
  "sma-cagr-presets": typeof nominalPresets;
  "sma-search-space": typeof nominalSearchSpace;
};

export function readSmaArtifact<B extends SmaArtifactBase>(base: B): ArtifactShape[B] {
  return JSON.parse(readFileSync(smaArtifactPath(base), "utf8")) as ArtifactShape[B];
}

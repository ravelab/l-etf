import { buildAxis } from "../../src/lib/simulation/grid-axis";
import { planBufferNeighborhood, planCombos, type SmaCombo } from "../../src/lib/simulation/sma-search";
import { SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER } from "../../src/lib/simulation/sma-search-bounds";

export const PRESET_PERIOD_STEP = 1;
export const PRESET_PERIOD_HALF_WIDTH = 5;
export const PRESET_BUFFER_STEP = 0.1;
export const PRESET_BUFFER_HALF_WIDTH = 1.2;

/** Stability is already penalized; plateau centering may only settle ties. */
export function preferStablePresetCenter<T extends { score: number }>(peak: T, center: T): T {
  return center.score >= peak.score - 1e-8 ? center : peak;
}

export function snapPresetCombo(combo: SmaCombo): SmaCombo {
  const snapBuffer = (value: number) => Math.round(value / PRESET_BUFFER_STEP) / 10;
  return { smaPeriod: Math.round(combo.smaPeriod / PRESET_PERIOD_STEP) * PRESET_PERIOD_STEP,
    smaUpperBuffer: snapBuffer(combo.smaUpperBuffer), smaLowerBuffer: snapBuffer(combo.smaLowerBuffer) };
}

export function refinePresetGrid(combo: SmaCombo, step = PRESET_BUFFER_STEP, halfWidth = 0.4): SmaCombo[] {
  const center = snapPresetCombo(combo);
  return planCombos(buildAxis(Math.max(SMA_SEARCH_MIN_PERIOD, center.smaPeriod - PRESET_PERIOD_HALF_WIDTH),
    Math.min(SMA_SEARCH_MAX_PERIOD, center.smaPeriod + PRESET_PERIOD_HALF_WIDTH), PRESET_PERIOD_STEP),
  planBufferNeighborhood(center.smaUpperBuffer, center.smaLowerBuffer, halfWidth, step,
    { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }), new Set<string>());
}

/** Revisit every period at known fine buffers, including distant improvements. */
export function sweepPresetPeriods(combos: SmaCombo[]): SmaCombo[] {
  const bands = [...new Map(combos.map(snapPresetCombo).map((combo) => [
    `${combo.smaUpperBuffer}|${combo.smaLowerBuffer}`,
    { upper: combo.smaUpperBuffer, lower: combo.smaLowerBuffer },
  ])).values()];
  return planCombos(buildAxis(SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD, PRESET_PERIOD_STEP), bands, new Set<string>());
}

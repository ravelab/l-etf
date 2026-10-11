import { buildAxis } from "../../src/lib/simulation/grid-axis";
import { planBufferNeighborhood, planCombos, type SmaCombo } from "../../src/lib/simulation/sma-search";
import { SMA_SEARCH_MIN_PERIOD, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MAX_BUFFER } from "../../src/lib/simulation/sma-search-bounds";

export const PRESET_PERIOD_STEP = 5;
export const PRESET_BUFFER_STEP = 0.1;
export const PRESET_BUFFER_HALF_WIDTH = 1.2;

export function snapPresetCombo(combo: SmaCombo): SmaCombo {
  const snapBuffer = (value: number) => Math.round(value / PRESET_BUFFER_STEP) / 10;
  return { smaPeriod: Math.round(combo.smaPeriod / PRESET_PERIOD_STEP) * PRESET_PERIOD_STEP,
    smaUpperBuffer: snapBuffer(combo.smaUpperBuffer), smaLowerBuffer: snapBuffer(combo.smaLowerBuffer) };
}

export function refinePresetGrid(combo: SmaCombo, step = PRESET_BUFFER_STEP, halfWidth = 0.4): SmaCombo[] {
  const center = snapPresetCombo(combo);
  return planCombos(buildAxis(Math.max(SMA_SEARCH_MIN_PERIOD, center.smaPeriod - PRESET_PERIOD_STEP),
    Math.min(SMA_SEARCH_MAX_PERIOD, center.smaPeriod + PRESET_PERIOD_STEP), PRESET_PERIOD_STEP),
  planBufferNeighborhood(center.smaUpperBuffer, center.smaLowerBuffer, halfWidth, step,
    { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }), new Set<string>());
}

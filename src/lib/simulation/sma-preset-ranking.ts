export const SMA_PRESET_RANKING = "Calibrated default first; alternatives pair SPX and NDX rules by descending stability-adjusted weighted multi-era score";

/** Pair ranked selections, never positional engine outputs. CAGR is descriptive. */
export function rankSmaPresetSets<S extends { score: number }, N extends { score: number }>(
  presets: Array<{ isCalibratedDefault: boolean; sp500: S; nasdaq100: N }>,
) {
  const defaults = presets.filter((preset) => preset.isCalibratedDefault);
  if (defaults.length !== 1) throw new Error("Preset ranking requires exactly one calibrated default");
  if (presets.some((preset) => !Number.isFinite(preset.sp500.score) || !Number.isFinite(preset.nasdaq100.score))) {
    throw new Error("Preset ranking requires finite multi-era scores for both indices");
  }
  const alternatives = presets.filter((preset) => !preset.isCalibratedDefault);
  const sp500 = alternatives.map((preset) => preset.sp500).sort((a, b) => b.score - a.score);
  const nasdaq100 = alternatives.map((preset) => preset.nasdaq100).sort((a, b) => b.score - a.score);
  return [
    { isCalibratedDefault: true, sp500: defaults[0].sp500, nasdaq100: defaults[0].nasdaq100 },
    ...sp500.map((rule, rank) => ({ isCalibratedDefault: false, sp500: rule, nasdaq100: nasdaq100[rank] })),
  ];
}

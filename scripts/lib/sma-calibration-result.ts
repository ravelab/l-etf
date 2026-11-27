import type { SmaCalibrationIndexResult } from "../../src/lib/sma-calibration";
import { SMA_CALIBRATION_INFLATION_ADJUSTED } from "../../src/lib/simulation/sma-calibration-eras";
import { primaryEra, SMA_CALIBRATION_ERAS } from "../../src/lib/simulation/sma-calibration-eras";
import { DEFAULT_RISK_OFF_ASSETS } from "../../src/lib/simulation/defaults";
import type { IndexKey } from "../../src/lib/simulation/types";
import { SMA_SEARCH_MAX_BUFFER, SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_BUFFER, SMA_SEARCH_MIN_PERIOD } from "../../src/lib/simulation/sma-search-bounds";
import { comboKey, planBufferNeighborhood, planCombos, planPeriodNeighborhood, type SmaCombo } from "../../src/lib/simulation/sma-search";
import { stabilityAdjustedSmaScore } from "../../src/lib/simulation/sma-stability-score";
import { evaluateCombosAcrossEras, type EraEvaluatedCombo, type SmaEraContexts } from "./sma-sweep-context";

/** Inflation-adjusted defaults selected with their current risk-off gates. */
export function selectedCalibrationBand(index: IndexKey, inflationAdjusted: boolean): SmaCombo | undefined {
  if (!inflationAdjusted) return undefined;
  return index === "sp500"
    ? { smaPeriod: 202, smaLowerBuffer: 11.5, smaUpperBuffer: 0.5 }
    : { smaPeriod: 158, smaLowerBuffer: 19, smaUpperBuffer: 7 };
}

export function scoreSelectedCalibrationBand(eras: SmaEraContexts, band: SmaCombo): SmaCalibrationIndexResult {
  const neighbors = planCombos(
    planPeriodNeighborhood(band.smaPeriod, 1, { minPeriod: SMA_SEARCH_MIN_PERIOD, maxPeriod: SMA_SEARCH_MAX_PERIOD }),
    planBufferNeighborhood(band.smaUpperBuffer, band.smaLowerBuffer, 0.1, 0.1,
      { minBuffer: SMA_SEARCH_MIN_BUFFER, maxBuffer: SMA_SEARCH_MAX_BUFFER }),
    new Set<string>(),
  );
  const rows = evaluateCombosAcrossEras(eras, neighbors);
  const center = rows.find((row) => comboKey(row.combo) === comboKey(band));
  if (!center || rows.length !== neighbors.length) throw new Error(`Incomplete calibration for ${eras.indexKey} ${comboKey(band)}`);
  const scores = rows.map((row) => row.score).sort((a, b) => a - b);
  return buildSmaCalibrationResult(eras.indexKey, center, stabilityAdjustedSmaScore(center.score, scores[0]),
    { minScore: scores[0], medianScore: scores[Math.floor(scores.length / 2)] }, rows.length);
}

/** Monthly and manual searches publish one calibration shape and objective. */
export function buildSmaCalibrationResult(indexKey: IndexKey, winner: EraEvaluatedCombo, score: number,
  stats: { minScore: number; medianScore: number }, evaluatedCombos: number): SmaCalibrationIndexResult {
  return {
    startDate: primaryEra(indexKey).startDate,
    windowLength: winner.row.avgWindowYears, historyWrap: false,
    eraWeights: Object.fromEntries(SMA_CALIBRATION_ERAS[indexKey].map((era) => [era.key, era.weight])),
    riskOffAsset: DEFAULT_RISK_OFF_ASSETS[indexKey],
    inflationAdjusted: SMA_CALIBRATION_INFLATION_ADJUSTED[indexKey],
    scoresByEra: { ...winner.scoresByEra },
    smaPeriod: winner.combo.smaPeriod, smaUpperBuffer: winner.combo.smaUpperBuffer, smaLowerBuffer: winner.combo.smaLowerBuffer,
    smaOnlySwitches: winner.smaOnlySwitches,
    score, baseScore: winner.score, stabilityPenalty: winner.score - score,
    avgReturn: winner.row.avgReturn, worstReturn: winner.row.worstReturn,
    avgMaxDrawdown: winner.row.avgMaxDrawdown, avgTrades: winner.row.avgTrades, evaluatedCombos,
    neighborhoodMinScore: Number.isFinite(stats.minScore) ? stats.minScore : undefined,
    neighborhoodMedianScore: Number.isFinite(stats.medianScore) ? stats.medianScore : undefined,
  };
}

import type { SmaCalibrationIndexResult } from "../../src/lib/sma-calibration";
import { primaryEra, SMA_CALIBRATION_ERAS } from "../../src/lib/simulation/sma-calibration-eras";
import type { IndexKey } from "../../src/lib/simulation/types";
import type { EraEvaluatedCombo } from "./sma-sweep-context";

/** Monthly and manual searches publish one calibration shape and objective. */
export function buildSmaCalibrationResult(indexKey: IndexKey, winner: EraEvaluatedCombo, score: number,
  stats: { minScore: number; medianScore: number }, evaluatedCombos: number): SmaCalibrationIndexResult {
  return {
    startDate: primaryEra(indexKey).startDate,
    eraWeights: Object.fromEntries(SMA_CALIBRATION_ERAS[indexKey].map((era) => [era.key, era.weight])),
    scoresByEra: { ...winner.scoresByEra },
    smaPeriod: winner.combo.smaPeriod, smaUpperBuffer: winner.combo.smaUpperBuffer, smaLowerBuffer: winner.combo.smaLowerBuffer,
    score, baseScore: winner.score, stabilityPenalty: winner.score - score,
    avgReturn: winner.row.avgReturn, worstReturn: winner.row.worstReturn,
    avgMaxDrawdown: winner.row.avgMaxDrawdown, avgTrades: winner.row.avgTrades, evaluatedCombos,
    neighborhoodMinScore: Number.isFinite(stats.minScore) ? stats.minScore : undefined,
    neighborhoodMedianScore: Number.isFinite(stats.medianScore) ? stats.medianScore : undefined,
  };
}

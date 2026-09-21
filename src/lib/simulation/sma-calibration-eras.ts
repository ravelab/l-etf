/**
 * The date ranges the SMA calibration is scored over, and how much each counts.
 *
 * Calibrating on one range picks a rule for one regime. The `start` ranges
 * (SPX 1988, NDX 1985) contain no 1929-32 and no 1973-74, so the combos that
 * win there are short-SMA rules that ride those crashes down 88-95% — the
 * score's `(maxDrawdown - 80)^4` capitulation term then detonates the moment
 * an older range is scored. SPX 32d -6.1%/+7.9% tops the `start` range at
 * 8,802 and scores -4,354 on `proto`; NDX 106d tops `start` at 21,450 and
 * scores -2,619 on `proto`.
 *
 * So every combo is scored on every era and the results are combined by
 * weight. The eras are the same presets the tool pages offer (see
 * `HISTORICAL_DATE_PRESETS` in `SharedToolInputs.tsx`) so a calibrated band can
 * be checked by hand against exactly the range it was scored on.
 *
 * Weights are deliberately lopsided toward the real index: the older ranges are
 * reconstructions (pre-1988 SPX is the Fama-French Hi-30 splice and before 1926
 * the Cowles-era rebuild; pre-1985 NDX is the Nasdaq Composite scaled to meet
 * NDX), so they are a robustness check, not an equal vote. Because the raw
 * score is already unbounded below through the capitulation term, a plain
 * weighted sum of raw scores is all the "must not be terrible anywhere" rule
 * that is needed — a combo that blows up in one era cannot win on the others.
 * Do NOT normalise the per-era scores before combining; min-max or z-scoring
 * would rescale a -51,721 wipeout into merely "the worst candidate" and throw
 * away precisely the signal these eras were added to carry.
 */

import {
  CONSTANT_NASDAQ100_SHORTCUT_DATE,
  CONSTANT_NASDAQ100_START_DATE,
  CONSTANT_SP500_PROXY_START_DATE,
  CONSTANT_SP500_SHORTCUT_DATE,
  CONSTANT_SP500_START_DATE,
} from "../constants";
import type { IndexKey } from "./types";

export type SmaEraKey = "proto" | "proxy" | "start";

interface SmaCalibrationEra {
  key: SmaEraKey;
  /** Matches a tool-page date preset exactly, so a result is reproducible by hand. */
  startDate: string;
  label: string;
  weight: number;
}

export const SMA_CALIBRATION_ERAS: Record<IndexKey, SmaCalibrationEra[]> = {
  sp500: [
    { key: "proto", startDate: CONSTANT_SP500_START_DATE, label: "SPX proto", weight: 1 },
    { key: "proxy", startDate: CONSTANT_SP500_PROXY_START_DATE, label: "SPX proxy", weight: 3 },
    { key: "start", startDate: CONSTANT_SP500_SHORTCUT_DATE, label: "SPX start", weight: 6 },
  ],
  nasdaq100: [
    { key: "proto", startDate: CONSTANT_NASDAQ100_START_DATE, label: "NDX proto", weight: 2 },
    { key: "start", startDate: CONSTANT_NASDAQ100_SHORTCUT_DATE, label: "NDX start", weight: 8 },
  ],
};

/** The era whose per-window metrics the calibration reports alongside the band. */
export function primaryEra(indexKey: IndexKey): SmaCalibrationEra {
  return SMA_CALIBRATION_ERAS[indexKey].reduce((best, era) => (era.weight > best.weight ? era : best));
}

/**
 * Weighted mean of the per-era scores, normalised by total weight so the result
 * stays on the same scale as a single-era score (and so the two indices, which
 * both total 10, stay comparable).
 *
 * A missing era makes the combo unrankable rather than silently cheap: dropping
 * it would divide by a smaller total and reward exactly the combos that failed
 * to produce a result in the era that would have condemned them.
 */
export function combineEraScores(
  indexKey: IndexKey,
  scoresByEra: Partial<Record<SmaEraKey, number>>
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const era of SMA_CALIBRATION_ERAS[indexKey]) {
    const score = scoresByEra[era.key];
    if (score === undefined || !Number.isFinite(score)) return Number.NaN;
    weighted += score * era.weight;
    totalWeight += era.weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : Number.NaN;
}

/** "proto 1 · proxy 3 · start 6" — for logs and the snapshot's provenance. */
export function describeEraWeights(indexKey: IndexKey): string {
  return SMA_CALIBRATION_ERAS[indexKey].map((era) => `${era.key} ${era.weight}`).join(" · ");
}

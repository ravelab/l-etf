/** Calibration scores one observed full-history path per index, without wrap. */

import {
  CONSTANT_NASDAQ100_SHORTCUT_DATE,
  CONSTANT_NASDAQ100_START_DATE,
  CONSTANT_SP500_PROXY_START_DATE,
  CONSTANT_SP500_START_DATE,
  CONSTANT_SP500_SHORTCUT_DATE,
} from "../constants";
import type { IndexKey } from "./types";

export type SmaEraKey = "proto" | "proxy" | "start";

interface SmaCalibrationEra {
  key: SmaEraKey;
  /** Matches a tool-page date preset exactly, so a result is reproducible by hand. */
  startDate: string;
  /** Exclusive-ish upper bound: the next era's start. Omitted on the live era. */
  endDate?: string;
  label: string;
  weight: number;
}

export const SMA_CALIBRATION_ERAS: Record<IndexKey, SmaCalibrationEra[]> = {
  sp500: [
    { key: "start", startDate: CONSTANT_SP500_SHORTCUT_DATE, label: "SPX start", weight: 100 },
  ],
  nasdaq100: [
    { key: "start", startDate: CONSTANT_NASDAQ100_SHORTCUT_DATE, label: "NDX start", weight: 100 },
  ],
};

/**
 * Whether an index's rules are scored with the volatility risk-off gate
 * (`vol-gate.ts`) layered on. The gate ships on by default for both indices,
 * so each default and alternative must be the rule that works best WITH it.
 */
export const SMA_CALIBRATION_VOL_GATE: Record<IndexKey, boolean> = { sp500: true, nasdaq100: true };

/** The era whose per-window metrics the calibration reports alongside the band. */
export function primaryEra(indexKey: IndexKey): SmaCalibrationEra {
  return SMA_CALIBRATION_ERAS[indexKey].reduce((best, era) => (era.weight > best.weight ? era : best));
}

/**
 * Weighted mean of the per-era scores, normalised by total weight so the result
 * stays on the same scale as a single-era score (and so the two indices, which
 * both total 100, stay comparable).
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

/** Metadata duration; actual scoring uses the first/last observed price dates. */
export function calibrationYears(indexKey: IndexKey, endDate: string): number {
  return (Date.parse(endDate) - Date.parse(primaryEra(indexKey).startDate)) / (365.25 * 86400000);
}

/** Historical CAGR diagnostics only; not part of calibration selection. */
export const SMA_HISTORICAL_ERAS: Record<IndexKey, SmaCalibrationEra[]> = {
  sp500: [
    {
      key: "proto",
      startDate: CONSTANT_SP500_START_DATE,
      endDate: CONSTANT_SP500_PROXY_START_DATE,
      label: "SPX proto",
      weight: 5,
    },
    {
      key: "proxy",
      startDate: CONSTANT_SP500_PROXY_START_DATE,
      endDate: CONSTANT_SP500_SHORTCUT_DATE,
      label: "SPX proxy",
      weight: 25,
    },
    { key: "start", startDate: CONSTANT_SP500_SHORTCUT_DATE, label: "SPX start", weight: 70 },
  ],
  nasdaq100: [
    {
      key: "proxy",
      startDate: CONSTANT_NASDAQ100_START_DATE,
      endDate: CONSTANT_NASDAQ100_SHORTCUT_DATE,
      label: "NDX proxy",
      weight: 5,
    },
    { key: "start", startDate: CONSTANT_NASDAQ100_SHORTCUT_DATE, label: "NDX start", weight: 95 },
  ],
};

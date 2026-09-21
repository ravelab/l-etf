/**
 * The date ranges the SMA calibration is scored over, and how much each counts.
 *
 * Calibrating on one range picks a rule for one regime. The modern ranges
 * contain no 1929-32 and no 1973-74, so the combos that win there are
 * short-SMA rules that ride those crashes down 88-95%, and the score's
 * `(maxDrawdown - 80)^4` capitulation term then detonates the moment an older
 * range is scored. A `start`-only search returned SPX 32d -6.1%/+7.9%, worth
 * 8,802 on `start` and -4,354 on the full history.
 *
 * The eras are DISJOINT: each one stops where the next begins, and each is
 * scored over its own range with history wrap ON and the SAME 10-year window
 * length as everywhere else. They used to be nested — every era ran to today,
 * so `start`'s windows were a subset of `proto`'s and the modern data was
 * counted in all of them. Under the old nested NDX 2:8 that left the pre-1985
 * segment an effective ~0.5/10 rather than 2/10, because only 167 of proto's
 * 668 windows began before 1985.
 *
 * Wrap is what makes an era's coverage uniform, and it is why every era keeps
 * it. Rolling windows cover an era's middle far more often than its edges: with
 * 10-year windows stepped monthly, a day in the middle sits in ~120 of them and
 * a day in the first month sits in 1. Wrapping replays the era's own opening
 * onto a window that runs past the era's end, so each era behaves as a cycle
 * and every year in it is counted about equally. Without it an era's score is a
 * statement about its middle years.
 *
 * Do NOT "fix" the edges by stretching the window to the era's length instead.
 * The score in `score.ts` is built from CROSS-window statistics — worst 10-year
 * CAGR, average max drawdown, trades per year — and was fitted against 10-year
 * windows. One window per era collapses `worstReturn` into `avgReturn`, kills
 * the `worstRealCagr * 9` term outright, and leaves total return driving
 * everything. Window length is 10 years in every era, always.
 *
 * Weights are still lopsided toward the real index — the older ranges are
 * reconstructions (pre-1988 SPX is the Fama-French Hi-30 splice and before 1926
 * the Cowles-era rebuild; pre-1985 NDX is the Nasdaq *Composite* scaled to meet
 * NDX, since the Nasdaq-100 did not exist yet) — so they are a stress test, not
 * an equal vote. Because the raw score is already unbounded below through the
 * capitulation term, a plain weighted sum of RAW per-era scores is all the
 * "must not be terrible anywhere" rule that is needed. Do NOT normalise the
 * per-era scores before combining; min-max or z-scoring would rescale a
 * -51,721 wipeout into merely "the worst candidate" and throw away precisely
 * the signal these eras carry.
 *
 * A closed era runs with history wrap OFF (see `buildSmaEraContexts`). Wrap
 * exists to extend the final windows past the end of DATA; a closed era's
 * windows always run into real data, so wrapping there would fabricate a tail
 * over history that exists. Only the live era, whose last windows really do run
 * off the end, keeps it.
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
  /** Exclusive-ish upper bound: the next era's start. Omitted on the live era. */
  endDate?: string;
  label: string;
  weight: number;
}

export const SMA_CALIBRATION_ERAS: Record<IndexKey, SmaCalibrationEra[]> = {
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
      key: "proto",
      startDate: CONSTANT_NASDAQ100_START_DATE,
      endDate: CONSTANT_NASDAQ100_SHORTCUT_DATE,
      label: "NDX proto",
      weight: 5,
    },
    { key: "start", startDate: CONSTANT_NASDAQ100_SHORTCUT_DATE, label: "NDX start", weight: 95 },
  ],
};

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

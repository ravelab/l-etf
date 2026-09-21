/**
 * The exhaustive-search artifact that seeds the monthly SMA calibration.
 *
 * `scripts/explore-sma-space.ts` writes it (tens of minutes, run by hand);
 * `scripts/calibrate-sma.ts` reads it on every monthly build (seconds). What it
 * stores per index is a PER-PERIOD buffer seed: for each SMA period, the
 * (upper, lower) pair that exhaustive search found best at that period.
 *
 * That split is deliberate. The score surface is spiky along the period axis
 * (NDX 105d beats 110d by 2.5x) but smooth in the buffer plane at a fixed
 * period, and it is the buffer plane that is expensive to search. So the
 * expensive run maps the smooth part once, and the cheap monthly run still
 * scans EVERY period — it just knows which buffer to try at each. A seed that
 * has gone slightly stale costs accuracy at one period, never a whole basin.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface SmaSeed {
  smaPeriod: number;
  smaUpperBuffer: number;
  smaLowerBuffer: number;
  /** Weighted mean across eras — what the search maximises. */
  score: number;
  /** The raw per-era scores behind it, so "not terrible anywhere" is checkable. */
  scoresByEra?: Record<string, number>;
}

export interface SmaSearchSpaceIndexResult {
  /** Highest-weighted era's start date — the band's headline range. */
  startDate: string;
  /** Era key -> weight, recorded so a stale file can be spotted after a reweight. */
  eraWeights?: Record<string, number>;
  /** Best combo over the whole exhaustive grid, at the time it was run. */
  best: SmaSeed;
  /** One entry per period on the grid, ascending. */
  periodSeeds: SmaSeed[];
}

export interface SmaSearchSpaceGrid {
  minPeriod: number;
  maxPeriod: number;
  periodStep: number;
  minBuffer: number;
  maxBuffer: number;
  bufferStep: number;
}

export interface SmaSearchSpaceSnapshot {
  generatedAt: string;
  endDate: string;
  windowLength: number;
  grid: SmaSearchSpaceGrid;
  sp500: SmaSearchSpaceIndexResult;
  nasdaq100: SmaSearchSpaceIndexResult;
}

const smaSeedSchema = z.object({
  smaPeriod: z.number(),
  smaUpperBuffer: z.number(),
  smaLowerBuffer: z.number(),
  score: z.number(),
  scoresByEra: z.record(z.string(), z.number()).optional(),
});

const smaSearchSpaceIndexResultSchema = z.object({
  startDate: z.string(),
  eraWeights: z.record(z.string(), z.number()).optional(),
  best: smaSeedSchema,
  periodSeeds: z.array(smaSeedSchema).min(1),
});

const smaSearchSpaceSnapshotSchema = z.object({
  generatedAt: z.string(),
  endDate: z.string(),
  windowLength: z.number(),
  grid: z.object({
    minPeriod: z.number(),
    maxPeriod: z.number(),
    periodStep: z.number(),
    minBuffer: z.number(),
    maxBuffer: z.number(),
    bufferStep: z.number(),
  }),
  sp500: smaSearchSpaceIndexResultSchema,
  nasdaq100: smaSearchSpaceIndexResultSchema,
});

export const SMA_SEARCH_SPACE_SNAPSHOT_PATH = join(
  process.cwd(),
  "src",
  "lib",
  "tool-snapshots",
  "sma-search-space.json"
);

export async function readSmaSearchSpaceSnapshot(): Promise<SmaSearchSpaceSnapshot | null> {
  try {
    const raw = await readFile(SMA_SEARCH_SPACE_SNAPSHOT_PATH, "utf-8");
    const parsed = smaSearchSpaceSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Buffer seed for a period. Falls back to the nearest seeded period rather than
 * to a constant, so a snapshot generated at a coarser period step — or one that
 * predates a widened period range — still steers every period sensibly.
 */
export function seedForPeriod(seeds: SmaSeed[], smaPeriod: number): SmaSeed | null {
  if (seeds.length === 0) return null;
  let best = seeds[0];
  let bestDistance = Math.abs(best.smaPeriod - smaPeriod);
  for (const seed of seeds) {
    const distance = Math.abs(seed.smaPeriod - smaPeriod);
    if (distance < bestDistance) {
      best = seed;
      bestDistance = distance;
    }
    if (bestDistance === 0) break;
  }
  return best;
}

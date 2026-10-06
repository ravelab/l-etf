import { comboKey, type SmaCombo } from "../../src/lib/simulation/sma-search";
import type { IndexKey } from "../../src/lib/simulation/types";
import type { SmaSearchSpaceIndexResult, SmaSeed } from "../../src/lib/sma-search-space";
import {
  SMA_SEARCH_MAX_PERIOD, SMA_SEARCH_MIN_PERIOD,
  SMA_SEARCH_MAX_BUFFER, SMA_SEARCH_MIN_BUFFER,
} from "../../src/lib/simulation/sma-search-bounds";
import { buildSmaEraContexts, evaluateCombosAcrossEras } from "./sma-sweep-context";

/** Keep freshly rescored fine-buffer candidates when a coarse grid misses them. */
export async function retainKnownSmaSeeds(
  indexKey: IndexKey,
  endDate: string,
  windowLength: number,
  result: SmaSearchSpaceIndexResult,
  candidates: SmaCombo[],
): Promise<SmaSearchSpaceIndexResult> {
  const known = [...new Map(candidates.map((candidate) => [comboKey(candidate), candidate])).values()]
    .filter((candidate) => candidate.smaPeriod >= SMA_SEARCH_MIN_PERIOD && candidate.smaPeriod <= SMA_SEARCH_MAX_PERIOD
      && candidate.smaUpperBuffer >= SMA_SEARCH_MIN_BUFFER && candidate.smaUpperBuffer <= SMA_SEARCH_MAX_BUFFER
      && candidate.smaLowerBuffer >= SMA_SEARCH_MIN_BUFFER && candidate.smaLowerBuffer <= SMA_SEARCH_MAX_BUFFER);
  if (known.length === 0) return result;
  const eras = await buildSmaEraContexts({ indexKey, endDate, windowLength, maxPeriod: SMA_SEARCH_MAX_PERIOD });
  const seeds = new Map(result.periodSeeds.map((seed) => [seed.smaPeriod, seed]));
  for (const evaluated of evaluateCombosAcrossEras(eras, known)) {
    const previous = seeds.get(evaluated.combo.smaPeriod);
    if (!previous || evaluated.score <= previous.score) continue;
    seeds.set(evaluated.combo.smaPeriod, {
      ...evaluated.combo,
      score: evaluated.score,
      scoresByEra: evaluated.scoresByEra,
    } satisfies SmaSeed);
  }
  const periodSeeds = [...seeds.values()].sort((a, b) => a.smaPeriod - b.smaPeriod);
  return { ...result, periodSeeds, best: periodSeeds.reduce((best, seed) => seed.score > best.score ? seed : best) };
}

/** Refresh every saved period's seed under today's data and scoring formula. */
import { writeFileSync } from "node:fs";
import { readSmaSearchSpaceSnapshot, SMA_SEARCH_SPACE_SNAPSHOT_PATH, type SmaSeed } from "../src/lib/sma-search-space";
import { readSmaCalibrationSnapshot } from "../src/lib/sma-calibration";
import { SMA_CALIBRATION_ERAS, primaryEra } from "../src/lib/simulation/sma-calibration-eras";
import { SMA_SEARCH_MAX_PERIOD } from "../src/lib/simulation/sma-search-bounds";
import { getDefaultWindowLength } from "../src/lib/simulation/defaults";
import { buildSmaEraContexts, evaluateCombosAcrossEras } from "./lib/sma-sweep-context";
import { getLatestSharedTradeDate } from "./lib/sweep-data";

async function main() {
  const previous = await readSmaSearchSpaceSnapshot();
  if (!previous) throw new Error("Missing SMA seeds; run explore-sma first");
  const calibration = await readSmaCalibrationSnapshot();
  const endDate = await getLatestSharedTradeDate(["sp500", "nasdaq100", "risk:SGOV"]);
  const windowLength = getDefaultWindowLength();
  const refreshed = { ...previous, generatedAt: new Date().toISOString(), endDate, windowLength,
    searchMode: "rescored-known-seeds" };
  for (const indexKey of ["sp500", "nasdaq100"] as const) {
    const eras = await buildSmaEraContexts({ indexKey, endDate, windowLength, maxPeriod: SMA_SEARCH_MAX_PERIOD });
    const candidates = [...previous[indexKey].periodSeeds];
    const saved = calibration?.[indexKey];
    if (saved) candidates.push(saved);
    const byPeriod = new Map<number, SmaSeed>();
    for (const row of evaluateCombosAcrossEras(eras, candidates)) {
      if ((byPeriod.get(row.combo.smaPeriod)?.score ?? -Infinity) >= row.score) continue;
      byPeriod.set(row.combo.smaPeriod, { ...row.combo, score: row.score, scoresByEra: row.scoresByEra });
    }
    if (byPeriod.size !== previous[indexKey].periodSeeds.length) throw new Error(`Incomplete ${indexKey} seed refresh`);
    const periodSeeds = [...byPeriod.values()].sort((a, b) => a.smaPeriod - b.smaPeriod);
    refreshed[indexKey] = { startDate: primaryEra(indexKey).startDate,
      eraWeights: Object.fromEntries(SMA_CALIBRATION_ERAS[indexKey].map((era) => [era.key, era.weight])),
      periodSeeds, best: periodSeeds.reduce((best, seed) => seed.score > best.score ? seed : best) };
    console.log(`[refresh-sma-seeds] ${indexKey}: ${periodSeeds.length} periods rescored`);
  }
  writeFileSync(SMA_SEARCH_SPACE_SNAPSHOT_PATH, JSON.stringify(refreshed, null, 2) + "\n");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

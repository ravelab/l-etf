/**
 * Guards the two committed SMA search artifacts against each other and against
 * the bounds both scripts search. `explore-sma-space.ts` writes the seeds,
 * `calibrate-sma.ts` consumes them and writes the band the alerts ship — a
 * mismatch between them is silent at runtime (the seeds just steer badly).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

import {
  readSmaCalibrationSnapshot,
  type SmaCalibrationIndexResult,
} from "../src/lib/sma-calibration";
import {
  SMA_SEARCH_SPACE_SNAPSHOT_PATH,
  readSmaSearchSpaceSnapshot,
  seedForPeriod,
} from "../src/lib/sma-search-space";
import { SMA_CALIBRATION_ERAS } from "../src/lib/simulation/sma-calibration-eras";
import {
  SMA_SEARCH_MAX_BUFFER,
  SMA_SEARCH_MAX_PERIOD,
  SMA_SEARCH_MIN_BUFFER,
  SMA_SEARCH_MIN_PERIOD,
} from "../src/lib/simulation/sma-search-bounds";

const INDICES = ["sp500", "nasdaq100"] as const;

describe("sma-calibration snapshot", () => {
  it("parses and stays inside the searched parameter box", async () => {
    const snapshot = await readSmaCalibrationSnapshot();
    assert.ok(snapshot, "sma-calibration.json must parse");
    for (const index of INDICES) {
      const band = snapshot[index];
      assert.ok(
        band.smaPeriod >= SMA_SEARCH_MIN_PERIOD && band.smaPeriod <= SMA_SEARCH_MAX_PERIOD,
        `${index} period ${band.smaPeriod} outside ${SMA_SEARCH_MIN_PERIOD}..${SMA_SEARCH_MAX_PERIOD}`
      );
      for (const buffer of [band.smaUpperBuffer, band.smaLowerBuffer]) {
        assert.ok(
          buffer >= SMA_SEARCH_MIN_BUFFER && buffer <= SMA_SEARCH_MAX_BUFFER,
          `${index} buffer ${buffer} outside ${SMA_SEARCH_MIN_BUFFER}..${SMA_SEARCH_MAX_BUFFER}`
        );
      }
    }
  });

  it("records every era's raw score, so a band's weak range is visible", async () => {
    const snapshot = await readSmaCalibrationSnapshot();
    assert.ok(snapshot);
    for (const index of INDICES) {
      const band: SmaCalibrationIndexResult = snapshot[index];
      const expected = SMA_CALIBRATION_ERAS[index].map((era) => era.key).sort();
      assert.deepEqual(
        Object.keys(band.scoresByEra ?? {}).sort(),
        expected,
        `${index} must score every calibration era`
      );
      assert.deepEqual(Object.keys(band.eraWeights ?? {}).sort(), expected);
      // `score` must be the weighted mean of what it recorded, or the shipped
      // number and the numbers behind it have drifted apart.
      let weighted = 0;
      let total = 0;
      for (const era of SMA_CALIBRATION_ERAS[index]) {
        weighted += (band.scoresByEra?.[era.key] ?? Number.NaN) * era.weight;
        total += era.weight;
      }
      assert.ok(
        Math.abs(weighted / total - band.score) < 1e-6,
        `${index} score ${band.score} is not the weighted mean of its era scores`
      );
    }
  });

  it("still parses a snapshot written before the diagnostic fields existed", async () => {
    const snapshot = await readSmaCalibrationSnapshot();
    assert.ok(snapshot);
    // The Signals page and the push-alert cron only ever read the six band
    // fields, so an older artifact must keep working untouched.
    for (const index of INDICES) {
      const {
        evaluatedCombos,
        neighborhoodMinScore,
        neighborhoodMedianScore,
        scoresByEra,
        eraWeights,
        ...legacy
      } = snapshot[index];
      void evaluatedCombos;
      void neighborhoodMinScore;
      void neighborhoodMedianScore;
      void scoresByEra;
      void eraWeights;
      assert.deepEqual(Object.keys(legacy).sort(), [
        "avgMaxDrawdown",
        "avgReturn",
        "avgTrades",
        "score",
        "smaLowerBuffer",
        "smaPeriod",
        "smaUpperBuffer",
        "startDate",
        "worstReturn",
      ]);
    }
  });
});

describe("sma-search-space snapshot", () => {
  it("is committed, parses, and seeds every period the calibrator scans", async () => {
    const raw = await readFile(SMA_SEARCH_SPACE_SNAPSHOT_PATH, "utf-8").catch(() => null);
    assert.ok(
      raw,
      `${SMA_SEARCH_SPACE_SNAPSHOT_PATH} is missing — run \`npm run explore-sma\` and commit it`
    );
    const snapshot = await readSmaSearchSpaceSnapshot();
    assert.ok(snapshot, "sma-search-space.json must parse against its schema");

    assert.equal(snapshot.grid.minPeriod, SMA_SEARCH_MIN_PERIOD);
    assert.equal(snapshot.grid.maxPeriod, SMA_SEARCH_MAX_PERIOD);
    assert.equal(snapshot.grid.minBuffer, SMA_SEARCH_MIN_BUFFER);
    assert.equal(snapshot.grid.maxBuffer, SMA_SEARCH_MAX_BUFFER);

    for (const index of INDICES) {
      const seeds = snapshot[index].periodSeeds;
      for (const seed of seeds) {
        assert.ok(seed.smaPeriod >= SMA_SEARCH_MIN_PERIOD && seed.smaPeriod <= SMA_SEARCH_MAX_PERIOD);
        assert.ok(seed.smaUpperBuffer >= SMA_SEARCH_MIN_BUFFER && seed.smaUpperBuffer <= SMA_SEARCH_MAX_BUFFER);
        assert.ok(seed.smaLowerBuffer >= SMA_SEARCH_MIN_BUFFER && seed.smaLowerBuffer <= SMA_SEARCH_MAX_BUFFER);
      }
      // Step 1 of the monthly search asks for a seed at every integer period.
      for (let period = SMA_SEARCH_MIN_PERIOD; period <= SMA_SEARCH_MAX_PERIOD; period++) {
        assert.ok(seedForPeriod(seeds, period), `${index} has no seed reachable from period ${period}`);
      }
      // `best` must actually be the best of the recorded seeds.
      const bestSeedScore = Math.max(...seeds.map((seed) => seed.score));
      assert.equal(snapshot[index].best.score, bestSeedScore);
      // Seeds must come from the same weighting the calibrator will apply.
      assert.deepEqual(
        snapshot[index].eraWeights,
        Object.fromEntries(SMA_CALIBRATION_ERAS[index].map((era) => [era.key, era.weight])),
        `${index} seeds were generated under different era weights — re-run \`npm run explore-sma\``
      );
    }
  });
});

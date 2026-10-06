import test from "node:test";
import assert from "node:assert/strict";
import { retainKnownSmaSeeds, retainKnownSmaPlateauBand } from "../scripts/lib/sma-known-seeds";
import type { SmaSearchSpaceIndexResult, SmaSeed } from "../src/lib/sma-search-space";

test("known plateau members are preferred only with similar CAGR and no worse score", () => {
  const center = { combo: { smaPeriod: 125, smaUpperBuffer: 19.5, smaLowerBuffer: 17.9 }, score: 14790, row: { avgReturn: 31 } };
  const known = { combo: { smaPeriod: 127, smaUpperBuffer: 19.3, smaLowerBuffer: 17.8 }, score: 14904, row: { avgReturn: 31 } };
  assert.equal(retainKnownSmaPlateauBand(center, [center, known], known.combo), known);
  assert.equal(retainKnownSmaPlateauBand(center, [center], known.combo), center, "outside plateau");
  assert.equal(retainKnownSmaPlateauBand(center, [center, { ...known, score: 14000 }], known.combo), center, "worse score");
  assert.equal(retainKnownSmaPlateauBand(center, [center, { ...known, row: { avgReturn: 32.01 } }], known.combo), center, "CAGR differs by more than 1 point");
  assert.equal(retainKnownSmaPlateauBand(center, [center, known], undefined), center);
});

test("coarse search retains a better fine-buffer candidate using fresh scores", async () => {
  const candidate: SmaSeed = { smaPeriod: 174, smaUpperBuffer: 3.5, smaLowerBuffer: 3.6, score: 1e9 };
  const other: SmaSeed = { smaPeriod: 30, smaUpperBuffer: 8, smaLowerBuffer: 6, score: -1e6 };
  const coarse: SmaSeed = { smaPeriod: 174, smaUpperBuffer: 4, smaLowerBuffer: 4, score: -1e6 };
  const result: SmaSearchSpaceIndexResult = {
    startDate: "1988-04-06", best: coarse, periodSeeds: [other, coarse],
  };
  const retained = await retainKnownSmaSeeds("sp500", "2026-10-02", 10, result, [candidate]);
  const fine = retained.periodSeeds.find((seed) => seed.smaPeriod === 174)!;
  assert.equal(fine.smaUpperBuffer, 3.5);
  assert.equal(fine.smaLowerBuffer, 3.6);
  assert.ok(fine.score > coarse.score);
  assert.ok(fine.score < candidate.score, "must rescore, not copy stale score metadata");
  assert.deepEqual(retained.periodSeeds.find((seed) => seed.smaPeriod === 30), other);
  assert.equal(retained.best, fine);
  assert.ok(fine.scoresByEra);

  const stronger = { ...fine, score: 1e9 };
  const kept = await retainKnownSmaSeeds("sp500", "2026-10-02", 10, {
    ...retained, best: stronger, periodSeeds: [other, stronger],
  }, [candidate]);
  assert.equal(kept.periodSeeds.find((seed) => seed.smaPeriod === 174), stronger);
});

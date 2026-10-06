import test from "node:test";
import assert from "node:assert/strict";
import { retainKnownSmaSeeds } from "../scripts/lib/sma-known-seeds";
import type { SmaSearchSpaceIndexResult, SmaSeed } from "../src/lib/sma-search-space";

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

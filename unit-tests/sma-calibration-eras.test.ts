/**
 * The era table decides what "best" means for the shipped SMA band, so these
 * pin the two things that would silently change it: the ranges themselves, and
 * how their scores combine.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  SMA_CALIBRATION_ERAS,
  combineEraScores,
  describeEraWeights,
  primaryEra,
} from "../src/lib/simulation/sma-calibration-eras";
import {
  CONSTANT_NASDAQ100_SHORTCUT_DATE,
  CONSTANT_NASDAQ100_START_DATE,
  CONSTANT_SP500_PROXY_START_DATE,
  CONSTANT_SP500_SHORTCUT_DATE,
  CONSTANT_SP500_START_DATE,
} from "../src/lib/constants";

describe("SMA_CALIBRATION_ERAS", () => {
  it("uses exactly the tool pages' date presets, so a band is reproducible by hand", () => {
    assert.deepEqual(
      SMA_CALIBRATION_ERAS.sp500.map((era) => [era.key, era.startDate]),
      [
        ["proto", CONSTANT_SP500_START_DATE],
        ["proxy", CONSTANT_SP500_PROXY_START_DATE],
        ["start", CONSTANT_SP500_SHORTCUT_DATE],
      ]
    );
    assert.deepEqual(
      SMA_CALIBRATION_ERAS.nasdaq100.map((era) => [era.key, era.startDate]),
      [
        ["proto", CONSTANT_NASDAQ100_START_DATE],
        ["start", CONSTANT_NASDAQ100_SHORTCUT_DATE],
      ]
    );
  });

  it("is disjoint: each era stops where the next begins", () => {
    // Nested eras counted the modern data in every era, so a weight did not
    // mean what it said — under the old nested NDX 2:8 the pre-1985 segment
    // carried an effective ~0.5/10, because only 167 of proto's 668 windows
    // began before 1985.
    for (const indexKey of ["sp500", "nasdaq100"] as const) {
      const eras = SMA_CALIBRATION_ERAS[indexKey];
      for (let i = 0; i < eras.length - 1; i++) {
        assert.equal(
          eras[i].endDate,
          eras[i + 1].startDate,
          `${indexKey}: ${eras[i].key} must end exactly where ${eras[i + 1].key} starts`
        );
      }
      // Only the live era runs to today; every closed era must bound itself.
      assert.equal(eras[eras.length - 1].endDate, undefined);
      assert.ok(eras.slice(0, -1).every((era) => era.endDate !== undefined));
    }
  });

  it("weights the real index above its reconstructions, and totals 10 on both", () => {
    for (const indexKey of ["sp500", "nasdaq100"] as const) {
      const eras = SMA_CALIBRATION_ERAS[indexKey];
      const total = eras.reduce((sum, era) => sum + era.weight, 0);
      assert.equal(total, 100, `${indexKey} weights must total 100 to stay comparable`);
      // Listed oldest-first, and weight must rise with data quality.
      for (let i = 1; i < eras.length; i++) {
        assert.ok(
          eras[i].weight > eras[i - 1].weight,
          `${indexKey}: ${eras[i].key} must outweigh ${eras[i - 1].key}`
        );
        assert.ok(eras[i].startDate > eras[i - 1].startDate, `${indexKey} eras must be oldest-first`);
      }
      assert.equal(primaryEra(indexKey).key, "start");
    }
  });
});

describe("combineEraScores", () => {
  it("is the weight-normalised mean", () => {
    // SPX 5:25:70 over /100.
    const score = combineEraScores("sp500", { proto: -4354, proxy: -3713, start: 8802 });
    assert.ok(Math.abs(score - (-4354 * 5 + -3713 * 25 + 8802 * 70) / 100) < 1e-9);
  });

  it("lets one catastrophic era sink a combo that wins the modern range", () => {
    // The real case: 20d -13.5%/+9% tops `start` but wipes out on `proxy`.
    const spike = combineEraScores("sp500", { proto: -17306, proxy: -51721, start: 8421 });
    const steady = combineEraScores("sp500", { proto: 2096, proxy: 3058, start: 6189 });
    assert.ok(spike < 0, "a -51,721 era must not survive");
    assert.ok(steady > spike);
  });

  it("refuses to rank a combo missing an era instead of dropping it", () => {
    // Dropping the era would divide by a smaller total and reward exactly the
    // combos that failed in the era that would have condemned them.
    assert.ok(Number.isNaN(combineEraScores("sp500", { proxy: 100, start: 100 })));
    assert.ok(Number.isNaN(combineEraScores("sp500", { proto: Number.NaN, proxy: 1, start: 1 })));
    assert.ok(Number.isNaN(combineEraScores("nasdaq100", { start: 21450 })));
  });

  it("equals the common value when every era agrees", () => {
    assert.equal(combineEraScores("nasdaq100", { proto: 500, start: 500 }), 500);
  });
});

describe("describeEraWeights", () => {
  it("renders the weights for logs and snapshot provenance", () => {
    assert.equal(describeEraWeights("sp500"), "proto 5 · proxy 25 · start 70");
    assert.equal(describeEraWeights("nasdaq100"), "proto 5 · start 95");
  });
});

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  comboKey,
  dedupeCombos,
  findScoreTies,
  limitTiesPerPeriod,
  pickMostStable,
  pickTop,
  pickTopDistinctPeriods,
  planBufferNeighborhood,
  planCombos,
  planPeriodNeighborhood,
  summarizePlateau,
  type ScoredCombo,
  type SmaCombo,
} from "../src/lib/simulation/sma-search";
import { buildAxis, roundToStep } from "../src/lib/simulation/grid-axis";
import { seedForPeriod, type SmaSeed } from "../src/lib/sma-search-space";

const BUFFER_BOUNDS = { minBuffer: 0, maxBuffer: 21 };
const PERIOD_BOUNDS = { minPeriod: 20, maxPeriod: 280 };

const combo = (smaPeriod: number, smaUpperBuffer: number, smaLowerBuffer: number): SmaCombo => ({
  smaPeriod,
  smaUpperBuffer,
  smaLowerBuffer,
});

const scored = (c: SmaCombo, score: number): ScoredCombo => ({ combo: c, score });

describe("grid-axis", () => {
  it("builds an inclusive axis and always contains the upper bound", () => {
    assert.deepEqual(buildAxis(0, 2, 0.5), [0, 0.5, 1, 1.5, 2]);
    // 21 is not a multiple of 2 — the bound still has to appear.
    assert.equal(buildAxis(0, 21, 2).at(-1), 21);
  });

  it("rounds off float drift so one grid point never becomes two", () => {
    assert.equal(roundToStep(0.30000000000000004, 0.1), 0.3);
    const axis = buildAxis(0, 1, 0.1);
    assert.equal(axis.length, 11);
    assert.deepEqual(axis, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it("returns nothing for a non-positive or non-finite step", () => {
    assert.deepEqual(buildAxis(0, 5, 0), []);
    assert.deepEqual(buildAxis(0, 5, Number.NaN), []);
  });
});

describe("planPeriodNeighborhood", () => {
  it("covers every integer period around the centre", () => {
    assert.deepEqual(planPeriodNeighborhood(100, 2, PERIOD_BOUNDS), [98, 99, 100, 101, 102]);
  });

  it("clamps to the bounds instead of running off the end", () => {
    assert.deepEqual(planPeriodNeighborhood(21, 3, PERIOD_BOUNDS), [20, 21, 22, 23, 24]);
    assert.deepEqual(planPeriodNeighborhood(279, 3, PERIOD_BOUNDS), [276, 277, 278, 279, 280]);
  });
});

describe("planBufferNeighborhood", () => {
  it("is a square centred on the seed", () => {
    const points = planBufferNeighborhood(10, 8, 1, 0.5, BUFFER_BOUNDS);
    assert.equal(points.length, 25);
    assert.ok(points.some((p) => p.upper === 10 && p.lower === 8));
    assert.ok(points.some((p) => p.upper === 9 && p.lower === 7));
    assert.ok(points.some((p) => p.upper === 11 && p.lower === 9));
  });

  it("clamps at the buffer bounds", () => {
    const atZero = planBufferNeighborhood(0, 21, 2, 1, BUFFER_BOUNDS);
    assert.ok(atZero.every((p) => p.upper >= 0 && p.upper <= 21));
    assert.ok(atZero.every((p) => p.lower >= 0 && p.lower <= 21));
    assert.ok(atZero.some((p) => p.upper === 0 && p.lower === 21));
  });
});

describe("planCombos", () => {
  it("crosses periods with buffer points", () => {
    const seen = new Set<string>();
    const combos = planCombos([10, 11], [{ upper: 1, lower: 2 }, { upper: 3, lower: 4 }], seen);
    assert.equal(combos.length, 4);
    assert.equal(seen.size, 4);
  });

  it("never re-plans a combo an earlier stage already evaluated", () => {
    const seen = new Set<string>([comboKey(combo(10, 1, 2))]);
    const combos = planCombos([10], [{ upper: 1, lower: 2 }, { upper: 3, lower: 4 }], seen);
    assert.deepEqual(combos, [combo(10, 3, 4)]);
  });

  it("treats float-drifted buffers as the same point", () => {
    const seen = new Set<string>();
    planCombos([10], [{ upper: 0.1 + 0.2, lower: 1 }], seen);
    const again = planCombos([10], [{ upper: 0.3, lower: 1 }], seen);
    assert.deepEqual(again, []);
  });
});

describe("dedupeCombos", () => {
  it("keeps the first sighting and records it as seen", () => {
    const seen = new Set<string>();
    const kept = dedupeCombos([combo(10, 1, 2), combo(10, 1, 2), combo(11, 1, 2)], seen);
    assert.deepEqual(kept, [combo(10, 1, 2), combo(11, 1, 2)]);
    assert.equal(seen.size, 2);
  });

  it("drops combos a prior stage already evaluated", () => {
    const seen = new Set<string>([comboKey(combo(11, 1, 2))]);
    assert.deepEqual(dedupeCombos([combo(10, 1, 2), combo(11, 1, 2)], seen), [combo(10, 1, 2)]);
  });
});

describe("pickTopDistinctPeriods", () => {
  it("opens up separate basins rather than one spike's neighbours", () => {
    const rows = [
      scored(combo(105, 18, 21), 21000),
      scored(combo(106, 18, 21), 20900),
      scored(combo(104, 18, 21), 20800),
      scored(combo(155, 21, 18), 17400),
      scored(combo(190, 6, 18), 15800),
    ];
    const top = pickTopDistinctPeriods(rows, 3, 4);
    assert.deepEqual(top.map((t) => t.combo.smaPeriod), [105, 155, 190]);
  });

  it("drops non-finite scores and honours the count", () => {
    const rows = [
      scored(combo(30, 1, 1), Number.NaN),
      scored(combo(60, 1, 1), 5),
      scored(combo(90, 1, 1), 7),
    ];
    const top = pickTopDistinctPeriods(rows, 5, 4);
    assert.deepEqual(top.map((t) => t.combo.smaPeriod), [90, 60]);
  });
});

describe("pickTop", () => {
  it("ranks by score and breaks ties toward the shorter period", () => {
    const rows = [scored(combo(200, 1, 1), 10), scored(combo(50, 1, 1), 10), scored(combo(80, 1, 1), 12)];
    assert.deepEqual(pickTop(rows, 2).map((t) => t.combo.smaPeriod), [80, 50]);
  });
});

describe("findScoreTies", () => {
  it("groups scores that differ only by float noise", () => {
    // The real SPX case: two combos that trade identically all history.
    const rows = [
      scored(combo(30, 8, 6.1), 8801.655297801957),
      scored(combo(31, 8, 6), 8801.655297801952),
      scored(combo(34, 8, 6), 8587.8),
    ];
    const ties = findScoreTies(rows, 1e-9);
    assert.deepEqual(ties.map((t) => t.combo.smaPeriod), [30, 31]);
  });

  it("does not group genuinely different scores", () => {
    const rows = [scored(combo(30, 8, 6), 8802), scored(combo(34, 8, 6), 8588)];
    assert.equal(findScoreTies(rows, 1e-9).length, 1);
  });

  it("uses a relative tolerance, so it works at any score magnitude", () => {
    // 0.0001 apart on 21450 is 4.7e-9 relative: inside 1e-5, outside 1e-10.
    const rows = [scored(combo(30, 8, 6), 21450), scored(combo(31, 8, 6), 21449.9999)];
    assert.equal(findScoreTies(rows, 1e-10).length, 1);
    assert.equal(findScoreTies(rows, 1e-5).length, 2);
  });

  it("returns nothing when no score is finite", () => {
    assert.deepEqual(findScoreTies([scored(combo(30, 8, 6), Number.NaN)], 1e-9), []);
  });
});

describe("limitTiesPerPeriod", () => {
  it("stops one period's buffer variants from filling the whole cap", () => {
    const ties = [
      scored(combo(30, 8, 6.0), 100),
      scored(combo(30, 8, 6.1), 100),
      scored(combo(30, 8, 6.2), 100),
      scored(combo(30, 8, 6.3), 100),
      scored(combo(31, 8, 6.0), 100),
    ];
    const kept = limitTiesPerPeriod(ties, 3, 4);
    assert.deepEqual(
      kept.map((k) => [k.combo.smaPeriod, k.combo.smaLowerBuffer]),
      [[30, 6], [30, 6.1], [30, 6.2], [31, 6]]
    );
  });

  it("honours the overall cap", () => {
    const ties = [20, 30, 40, 50].map((p) => scored(combo(p, 8, 6), 100));
    assert.equal(limitTiesPerPeriod(ties, 3, 2).length, 2);
  });
});

describe("pickMostStable", () => {
  it("prefers the tied combo whose worst neighbour is least bad", () => {
    const fragile = combo(30, 8, 6.1);
    const solid = combo(34, 8, 6);
    const rows = [
      scored(fragile, 8802),
      scored(solid, 8802),
      // fragile's neighbours collapse; solid's hold up.
      scored(combo(30, 8, 6.2), 2148),
      scored(combo(34, 8, 6.1), 8500),
    ];
    const chosen = pickMostStable([scored(fragile, 8802), scored(solid, 8802)], rows, 1, 0.1);
    assert.equal(chosen.combo.smaPeriod, 34);
  });

  it("ranks a candidate with no evaluated neighbours last", () => {
    const known = combo(30, 8, 6);
    const unknown = combo(200, 3, 3);
    const rows = [scored(known, 100), scored(unknown, 100), scored(combo(30, 8, 6.1), 90)];
    const chosen = pickMostStable([scored(unknown, 100), scored(known, 100)], rows, 1, 0.1);
    assert.equal(chosen.combo.smaPeriod, 30);
  });

  it("breaks a remaining tie toward the shorter period", () => {
    const a = combo(30, 8, 6);
    const b = combo(40, 8, 6);
    const rows = [scored(a, 100), scored(b, 100), scored(combo(31, 8, 6), 90), scored(combo(41, 8, 6), 90)];
    assert.equal(pickMostStable([scored(b, 100), scored(a, 100)], rows, 1, 0.1).combo.smaPeriod, 30);
  });

  it("throws rather than inventing a winner from nothing", () => {
    assert.throws(() => pickMostStable([], [], 1, 0.1));
  });
});

describe("summarizePlateau", () => {
  const winner = combo(100, 5, 5);

  it("measures only the winner's one-step neighbours", () => {
    const rows = [
      scored(winner, 1000),
      scored(combo(101, 5, 5), 900),
      scored(combo(99, 5, 5), 800),
      scored(combo(100, 5.1, 5), 700),
      // Two steps away on the period axis — must not count.
      scored(combo(102, 5, 5), -5000),
    ];
    const stats = summarizePlateau(winner, rows, 1, 0.1);
    assert.equal(stats.neighborCount, 3);
    assert.equal(stats.minScore, 700);
    assert.equal(stats.medianScore, 800);
  });

  it("reports a knife-edge optimum through its worst neighbour", () => {
    const rows = [scored(winner, 20000), scored(combo(101, 5, 5), 8000)];
    const stats = summarizePlateau(winner, rows, 1, 0.1);
    assert.equal(stats.minScore, 8000);
  });

  it("returns NaN when nothing adjacent was evaluated", () => {
    const stats = summarizePlateau(winner, [scored(winner, 1)], 1, 0.1);
    assert.equal(stats.neighborCount, 0);
    assert.ok(Number.isNaN(stats.minScore));
  });
});

describe("seedForPeriod", () => {
  const seeds: SmaSeed[] = [
    { smaPeriod: 20, smaUpperBuffer: 9, smaLowerBuffer: 21, score: 1 },
    { smaPeriod: 30, smaUpperBuffer: 6, smaLowerBuffer: 6, score: 2 },
    { smaPeriod: 40, smaUpperBuffer: 9, smaLowerBuffer: 15, score: 3 },
  ];

  it("returns the exact period when the snapshot has it", () => {
    assert.equal(seedForPeriod(seeds, 30)?.smaUpperBuffer, 6);
  });

  it("falls back to the nearest seeded period, not to a constant", () => {
    assert.equal(seedForPeriod(seeds, 38)?.smaPeriod, 40);
    assert.equal(seedForPeriod(seeds, 1000)?.smaPeriod, 40);
  });

  it("returns null for an empty seed list", () => {
    assert.equal(seedForPeriod([], 100), null);
  });
});

/**
 * The plateau picker decides the parameters that actually ship, and the same
 * rule runs behind the sweep pages' "best" tiles, so these pin the behaviour
 * that makes it worth having: it must move off a cliff edge, and it must never
 * answer with a point that is not itself near-best.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  PLATEAU_TOLERANCE,
  findPlateau,
  inferSteps,
  pickPlateauCenter,
  type PlateauCandidate,
} from "../src/lib/simulation/plateau";

const at = (coords: number[], score: number): PlateauCandidate<string> => ({
  item: coords.join("/"),
  coords,
  score,
});

describe("findPlateau", () => {
  it("returns the middle of a flat run, not its edge", () => {
    // The measured NDX period axis: 125-127 are level, 128 falls off a cliff.
    const candidates = [
      at([121], 17400),
      at([122], 17400),
      at([123], 17400),
      at([124], 17400),
      at([125], 18050),
      at([126], 18050),
      at([127], 18050),
      at([128], 8780),
    ];
    const result = findPlateau(candidates, { tolerance: PLATEAU_TOLERANCE, steps: [1] });
    assert.ok(result);
    assert.equal(result.peak.coords[0], 125, "argmax takes the first of the tied run");
    assert.equal(result.center.coords[0], 126, "centre of {125,126,127}");
    assert.deepEqual(result.members.map((m) => m.coords[0]).sort((a, b) => a - b), [125, 126, 127]);
    assert.deepEqual(result.widths, [2]);
  });

  it("leaves an already-central winner where it is", () => {
    // The measured SPX period axis around 174.
    const candidates = [
      at([172], 5060),
      at([173], 5730),
      at([174], 5750),
      at([175], 5730),
      at([176], 5430),
    ];
    assert.equal(findPlateau(candidates, { tolerance: PLATEAU_TOLERANCE, steps: [1] })?.center.coords[0], 174);
  });

  it("excludes a shelf that is genuinely lower", () => {
    // NDX's 121-124 sit 3.6% below — outside a 2% band, so they must not drag
    // the centre down to ~124.
    const candidates = [
      at([121], 17400),
      at([122], 17400),
      at([123], 17400),
      at([124], 17400),
      at([125], 18050),
      at([126], 18050),
      at([127], 18050),
    ];
    const result = findPlateau(candidates, { tolerance: 0.02, steps: [1] });
    assert.equal(result?.center.coords[0], 126);
    assert.equal(result?.members.length, 3);
    // Widen the band past the shelf's 3.6% and it joins, moving the centre —
    // the tolerance is doing real work, so changing it changes what ships.
    const wide = findPlateau(candidates, { tolerance: 0.05, steps: [1] });
    assert.equal(wide?.members.length, 7);
    assert.equal(wide?.center.coords[0], 124);
  });

  it("never crosses a gap into a separate basin of equal height", () => {
    // Two flat regions at the same height with a chasm between them. The
    // midpoint of their union would be 15 — a point that scores -9000.
    const candidates = [
      at([10], 1000),
      at([11], 1000),
      at([12], 1000),
      at([15], -9000),
      at([18], 1000),
      at([19], 1000),
      at([20], 1000),
    ];
    const result = findPlateau(candidates, { tolerance: 0.02, steps: [1] });
    assert.ok(result);
    assert.equal(result.center.coords[0], 11, "stays in the peak's own region");
    assert.equal(result.members.length, 3);
  });

  it("centres in every dimension at once", () => {
    // A 3x3 flat square with a low rim: the centre cell must win.
    const candidates: PlateauCandidate<string>[] = [];
    for (let u = 0; u <= 4; u++) {
      for (let l = 0; l <= 4; l++) {
        const inner = u >= 1 && u <= 3 && l >= 1 && l <= 3;
        candidates.push(at([u, l], inner ? 1000 : 100));
      }
    }
    const result = findPlateau(candidates, { tolerance: 0.02, steps: [1, 1] });
    assert.deepEqual(result?.center.coords, [2, 2]);
    assert.equal(result?.members.length, 9);
    assert.deepEqual(result?.widths, [2, 2]);
  });

  it("weighs axes in grid steps, not raw units", () => {
    // Period moves in 1s, buffer in 0.1s. Without step normalisation the buffer
    // axis would contribute ~nothing to the distance and the centre would be
    // chosen on period alone.
    const candidates = [
      at([100, 10.0], 1000),
      at([100, 10.1], 1000),
      at([100, 10.2], 1000),
      at([101, 10.0], 1000),
      at([101, 10.1], 1000),
      at([101, 10.2], 1000),
    ];
    const center = findPlateau(candidates, { tolerance: 0.02, steps: [1, 0.1] })?.center;
    assert.equal(center?.coords[1], 10.1, "buffer axis must be centred too");
  });

  it("handles a single point and a peak with no neighbours", () => {
    const solo = findPlateau([at([5], 42)], { tolerance: 0.02, steps: [1] });
    assert.equal(solo?.center.coords[0], 5);
    assert.deepEqual(solo?.widths, [0]);

    const spike = findPlateau([at([1], 10), at([2], 1000), at([3], 10)], {
      tolerance: 0.02,
      steps: [1],
    });
    assert.equal(spike?.center.coords[0], 2, "a knife edge is its own plateau");
    assert.equal(spike?.members.length, 1);
  });

  it("ignores non-finite scores and returns null for nothing scoreable", () => {
    const withNaN = findPlateau([at([1], Number.NaN), at([2], 500)], { tolerance: 0.02, steps: [1] });
    assert.equal(withNaN?.center.coords[0], 2);
    assert.equal(findPlateau([at([1], Number.NaN)], { tolerance: 0.02, steps: [1] }), null);
    assert.equal(findPlateau([], { tolerance: 0.02, steps: [1] }), null);
  });

  it("uses an absolute floor when the best score is near zero", () => {
    // 2% of 1 is 0.02, which would isolate the peak; the floor keeps the run together.
    const candidates = [at([1], 0.5), at([2], 1), at([3], 0.9), at([4], -50)];
    const tight = findPlateau(candidates, { tolerance: 0.02, steps: [1] });
    assert.equal(tight?.members.length, 1);
    const floored = findPlateau(candidates, { tolerance: 0.02, steps: [1], minAbsoluteTolerance: 0.6 });
    assert.equal(floored?.members.length, 3);
    assert.equal(floored?.center.coords[0], 2);
  });

  it("breaks a tie for the peak on coordinates, not array order", () => {
    // Two equal, NON-adjacent cells: they are separate regions, so which one is
    // the peak decides the answer. It must not depend on input order.
    const a = [at([3, 1], 12), at([1, 3], 12), at([2, 2], 10)];
    const b = [at([1, 3], 12), at([3, 1], 12), at([2, 2], 10)];
    const opts = { tolerance: 0.02, steps: [1, 1] };
    assert.equal(pickPlateauCenter(a, opts), "1/3");
    assert.equal(pickPlateauCenter(b, opts), "1/3");
  });

  it("compares coordinates numerically, not as strings", () => {
    // A string compare would put "10" before "9" and pick the wrong peak.
    const candidates = [at([10], 500), at([9], 500), at([30], 1)];
    assert.equal(pickPlateauCenter(candidates, { tolerance: 0.02, steps: [1] }), "9");
  });

  it("is order-independent", () => {
    const candidates = [at([125], 18050), at([127], 18050), at([126], 18050), at([128], 8780)];
    const forward = pickPlateauCenter(candidates, { tolerance: 0.02, steps: [1] });
    const reversed = pickPlateauCenter([...candidates].reverse(), { tolerance: 0.02, steps: [1] });
    assert.equal(forward, reversed);
    assert.equal(forward, "126");
  });
});

describe("inferSteps", () => {
  it("takes the smallest positive gap on each axis", () => {
    const candidates = [at([10, 1], 1), at([20, 1.5], 1), at([25, 3], 1)];
    assert.deepEqual(inferSteps(candidates, 2), [5, 0.5]);
  });

  it("falls back to 1 when an axis never varies", () => {
    assert.deepEqual(inferSteps([at([7], 1), at([7], 2)], 1), [1]);
  });
});

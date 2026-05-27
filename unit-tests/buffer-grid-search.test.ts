import test from "node:test";
import assert from "node:assert/strict";
import {
  planCoarseGrid,
  planFineGrid,
  dedupePoints,
  pickTopCell,
  scoreRow,
  topK,
  type AsymmetricSweepRow,
} from "@/lib/simulation/buffer-grid-search";

function makeRow(upper: number, lower: number, avgReturn: number, opts: Partial<AsymmetricSweepRow> = {}): AsymmetricSweepRow {
  return {
    parameterValue: 0,
    avgFinalRealValue: 0,
    avgReturn,
    bestReturn: avgReturn,
    worstReturn: avgReturn - 5,
    avgMaxDrawdown: -10,
    biggestMaxDrawdown: -20,
    avgTrades: 1,
    avgTradingCostPct: 0,
    upperBuffer: upper,
    lowerBuffer: lower,
    stage: "coarse",
    ...opts,
  };
}

test("planCoarseGrid covers the rectangle with the requested step", () => {
  const points = planCoarseGrid({ minUpper: 0, maxUpper: 4, minLower: 0, maxLower: 2, coarseStep: 2 });
  // upper: 0,2,4 ; lower: 0,2 → 3*2 = 6 points
  assert.equal(points.length, 6);
  // First row should be (0,0); deduping/rounding should preserve int values
  assert.deepEqual(points[0], { upper: 0, lower: 0 });
  // Should include the boundary
  assert.ok(points.some((p) => p.upper === 4 && p.lower === 2));
});

test("planCoarseGrid handles step larger than range (degenerate)", () => {
  const points = planCoarseGrid({ minUpper: 1, maxUpper: 1, minLower: 1, maxLower: 1, coarseStep: 5 });
  assert.equal(points.length, 1);
  assert.deepEqual(points[0], { upper: 1, lower: 1 });
});

test("planFineGrid clamps to the original bounds", () => {
  const points = planFineGrid({
    centerUpper: 0,
    centerLower: 18,
    halfWidth: 3,
    fineStep: 1,
    bounds: { minUpper: 0, maxUpper: 18, minLower: 0, maxLower: 18 },
  });
  // Upper window 0..3, Lower window 15..18 → no negative / no >18 values
  for (const p of points) {
    assert.ok(p.upper >= 0 && p.upper <= 18);
    assert.ok(p.lower >= 0 && p.lower <= 18);
  }
  // Includes corners
  assert.ok(points.some((p) => p.upper === 0 && p.lower === 18));
  assert.ok(points.some((p) => p.upper === 3 && p.lower === 15));
});

test("dedupePoints filters already-evaluated coarse cells", () => {
  const coarse = [{ upper: 2, lower: 2 }];
  const fine = [
    { upper: 2, lower: 2 }, // dup
    { upper: 2.5, lower: 2 },
    { upper: 2, lower: 1.5 },
  ];
  const deduped = dedupePoints(fine, coarse);
  assert.equal(deduped.length, 2);
  assert.ok(!deduped.some((p) => p.upper === 2 && p.lower === 2));
});

test("pickTopCell picks the highest objective and is deterministic on ties", () => {
  const rows: AsymmetricSweepRow[] = [
    makeRow(2, 2, 10),
    makeRow(3, 1, 12),
    makeRow(1, 3, 12), // tie with above
  ];
  const top = pickTopCell(rows, "avgRealCagr", 0);
  assert.ok(top);
  // Tie-break prefers lower upperBuffer, so (1, 3) wins.
  assert.equal(top!.upperBuffer, 1);
  assert.equal(top!.lowerBuffer, 3);
});

test("pickTopCell ignores NaN/infinite scores", () => {
  const rows: AsymmetricSweepRow[] = [
    makeRow(2, 2, Number.NaN),
    makeRow(3, 3, 8),
  ];
  const top = pickTopCell(rows, "avgRealCagr", 0);
  assert.ok(top);
  assert.equal(top!.upperBuffer, 3);
});

test("scoreRow subtracts inflation for avgRealCagr", () => {
  const row = makeRow(1, 1, 10);
  assert.equal(scoreRow(row, "avgRealCagr", 3), 7);
});

test("scoreRow for sharpeLike returns avg/|dd|", () => {
  const row = makeRow(1, 1, 10, { biggestMaxDrawdown: -20 });
  // (10 - 0) / 20 = 0.5
  assert.equal(scoreRow(row, "sharpeLike", 0), 0.5);
});

test("topK returns rows sorted by score, capped to k", () => {
  const rows: AsymmetricSweepRow[] = [
    makeRow(1, 1, 5),
    makeRow(2, 2, 9),
    makeRow(3, 3, 7),
    makeRow(4, 4, 8),
  ];
  const tops = topK(rows, "avgRealCagr", 0, 3);
  assert.equal(tops.length, 3);
  assert.deepEqual(
    tops.map((r) => r.avgReturn),
    [9, 8, 7]
  );
});

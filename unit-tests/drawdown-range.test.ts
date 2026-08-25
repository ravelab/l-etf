import test from "node:test";
import assert from "node:assert/strict";
import { buildDrawdownRangeQuery } from "../src/lib/simulation/drawdown-range";
import { computeRenormalizedPathMetrics } from "../src/lib/simulation/window-calculations";

// Deterministic pseudo-random walk so the test is reproducible.
function makeSeries(n: number, seed: number): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    v *= 1 + (rand() - 0.48) * 0.06;
    out.push(v);
  }
  return out;
}

test("segment-tree range drawdown matches the renormalized walk on every window", () => {
  for (const seed of [1, 7, 4242]) {
    const values = makeSeries(300, seed);
    const query = buildDrawdownRangeQuery(values);

    for (let start = 0; start < values.length - 2; start += 17) {
      for (let end = start + 1; end < values.length; end += 23) {
        const walk = computeRenormalizedPathMetrics(values, start, end, 0);
        assert.notEqual(walk, null);
        const tree = query(start, end);
        assert.ok(
          Math.abs(tree.pct - walk!.maxDrawdownPct * 100) < 1e-9,
          `seed ${seed} window [${start},${end}]: tree ${tree.pct} vs walk ${walk!.maxDrawdownPct * 100}`
        );
      }
    }
  }
});

test("range drawdown is invariant to the entry-spread rescale", () => {
  // The tree is built on raw values but queried for windows that get
  // renormalized; drawdown pct must not move under a positive scalar.
  const values = makeSeries(200, 99);
  const query = buildDrawdownRangeQuery(values);
  for (const entrySpread of [0, 0.0001, 0.01]) {
    const walk = computeRenormalizedPathMetrics(values, 10, 180, entrySpread);
    assert.ok(
      Math.abs(query(10, 180).pct - walk!.maxDrawdownPct * 100) < 1e-9,
      `entrySpread ${entrySpread} changed the drawdown`
    );
  }
});

test("degenerate ranges return zero drawdown", () => {
  const query = buildDrawdownRangeQuery([100, 90, 120]);
  assert.deepEqual(query(1, 1), { pct: 0, dollar: 0, longestDays: 0 });
  assert.deepEqual(query(2, 1), { pct: 0, dollar: 0, longestDays: 0 });
});

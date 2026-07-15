import test from "node:test";
import assert from "node:assert/strict";
import { buildSimulationBuckets } from "../src/lib/simulation/parallel";
import { calcCagr } from "../src/lib/simulation/metrics";
import type { RollingWindow } from "../src/lib/simulation/rolling";
import type { PricePoint } from "../src/lib/simulation/types";

// buildSimulationBuckets (and its per-window extractRegularWindowSimulation
// helper) is the piece of parallel.ts that turns pre-computed full-history
// daily values into a single rolling-window result: renormalizing to the
// window's start, slicing trade counts/costs via prefix sums, and picking
// entry/exit spreads from the risk-off state at the window edges. The pure
// math it calls (computeRenormalizedPathMetrics, selectEdgeSpreads, ...) is
// already unit-tested directly in window-calculations.test.ts; this file
// tests the wiring in parallel.ts that assembles them for a window that
// doesn't start at index 0, which nothing else exercises directly.

function assertClose(actual: number, expected: number, tolerance: number, msg: string) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${msg}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

const dates = [
  "2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04",
  "2020-01-05", "2020-01-06", "2020-01-07", "2020-01-08",
];
const timestamps = dates.map((d) => new Date(`${d}T00:00:00Z`).getTime());
const dummyPrices: PricePoint[] = dates.map((date) => ({ date, adj_close: 1, close: 1 }));

test("extractRegularWindowSimulation renormalizes, sums trade costs via prefix arrays, and selects edge spreads", () => {
  const dailyValues = [1, 1.05, 1.21, 1.0, 1.5, 1.5, 0.9, 1.8];
  const nonLeveragedValues = [1, 1.05, 1.1, 1.08, 1.2, 1.25, 1.15, 1.3];

  // Two trades inside the window (indices 3 and 5); prefix sums as the
  // engine builds them via buildTradePrefixes.
  const tradeCountPrefix = Uint32Array.from([0, 0, 0, 0, 1, 1, 2, 2, 2]);
  const tradeValuePrefix = Float64Array.from([0, 0, 0, 0, 1.0, 1.0, 2.5, 2.5, 2.5]);

  // Window starts risk-on (index 2), ends risk-off (index 6).
  const riskOffStateByIndex = Int8Array.from([0, 0, 0, 0, 0, 0, 1, 0]);

  const precomputed = {
    configId: "cfg-a",
    indexKey: "sp500" as const,
    dailyValues,
    nonLeveragedValues,
    timestamps,
    tradeCountPrefix,
    tradeValuePrefix,
    riskOffStateByIndex,
    perTransitionSpreadFraction: 0.001,
    riskOnSpreadRegular: 0.0001,
    riskOffSpreadRegular: 0.0002,
  };

  const window: RollingWindow = {
    startIdx: 2,
    endIdx: 6,
    startDate: dates[2],
    endDate: dates[6],
    lastRealEndDate: dates[6],
    usesSyntheticTail: false,
  };

  const buckets = buildSimulationBuckets([precomputed], [window], dummyPrices);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].configId, "cfg-a");
  assert.equal(buckets[0].simulations.length, 1);
  const sim = buckets[0].simulations[0];

  // Entry spread (start not risk-off → risk-on spread) is folded into the
  // renormalization factor per the entry/exit spread contract (AGENTS.md),
  // so it compounds through the whole path: factor = (1 - entrySpread)/1.21.
  // Peak/drawdown are unaffected since (1 - entrySpread) is a uniform scalar
  // on every renormalized value, including the peak — the ratio cancels out.
  const entrySpread = 0.0001;
  const exitSpread = 0.0002; // end risk-off → risk-off spread
  const factor = (1 - entrySpread) / 1.21;
  const rawFinalValue = 0.9 * factor;
  assertClose(sim.maxDrawdownPct, 40, 1e-9, "maxDrawdownPct");

  // Non-leveraged path is computed without an entry spread (window-calculations.ts's
  // computeOptionalNonLeveragedMetrics never receives one): factor = 1/1.1,
  // peak 25/22 (day 5), ends 23/22 (day 6) → 8%.
  assertClose(sim.nonLeveragedMaxDrawdownPct, 8, 1e-9, "nonLeveragedMaxDrawdownPct");
  assertClose(sim.nonLeveragedFinalValue, 1.15 / 1.1, 1e-9, "nonLeveragedFinalValue");

  assert.equal(sim.tradeCount, 2);

  const internalDollarCost = factor * 0.001 * 2.5;
  const entryDollarCost = 1 * entrySpread; // reported cost; already folded into rawFinalValue above
  const exitDollarCost = rawFinalValue * exitSpread;
  const totalDollarCost = entryDollarCost + internalDollarCost + exitDollarCost;
  const expectedFinalValue = rawFinalValue - exitDollarCost;
  assertClose(sim.finalValue, expectedFinalValue, 1e-9, "finalValue");
  const expectedCostPct = (totalDollarCost / expectedFinalValue) * 100;
  assertClose(sim.totalTradingCostPct, expectedCostPct, 1e-6, "totalTradingCostPct");
  assertClose(sim.totalReturnPct, (expectedFinalValue - 1) * 100, 1e-9, "totalReturnPct");

  const expectedCagr = calcCagr(1, expectedFinalValue, timestamps[2], timestamps[6], dates[2], dates[6]);
  assertClose(sim.cagr, expectedCagr, 1e-9, "cagr");
});

test("extractRegularWindowSimulation falls back to trade-index scan and full-value entry/exit spreads when no prefix arrays or risk-off state are present", () => {
  const dailyValues = [1, 1.1, 1.21, 0.8];

  const precomputed = {
    configId: "cfg-b",
    indexKey: "nasdaq100" as const,
    dailyValues,
    timestamps: timestamps.slice(0, 4),
    tradeDayIndices: [1],
    riskOnSpreadRegular: 0.0005,
    riskOffSpreadRegular: 0.0007,
  };

  const window: RollingWindow = {
    startIdx: 0,
    endIdx: 3,
    startDate: dates[0],
    endDate: dates[3],
    lastRealEndDate: dates[3],
    usesSyntheticTail: false,
  };

  const buckets = buildSimulationBuckets([precomputed], [window], dummyPrices.slice(0, 4));
  const sim = buckets[0].simulations[0];

  assert.equal(sim.tradeCount, 1);
  // No riskOffStateByIndex → isRiskOffAt is always false → both edges use
  // the risk-on spread. Entry spread is folded into the renormalization
  // factor (AGENTS.md contract): factor = (1 - entrySpread)/1 since values
  // already start at 1.
  const spread = 0.0005;
  const factor = 1 - spread;
  const rawFinalValue = 0.8 * factor;
  const entryDollarCost = 1 * spread;
  const exitDollarCost = rawFinalValue * spread;
  const expectedFinalValue = rawFinalValue - exitDollarCost;
  assertClose(sim.finalValue, expectedFinalValue, 1e-9, "finalValue");
  assertClose(
    sim.totalTradingCostPct,
    ((entryDollarCost + exitDollarCost) / expectedFinalValue) * 100,
    1e-6,
    "totalTradingCostPct"
  );
});

test("windows shorter than 2 days are dropped from the bucket", () => {
  const precomputed = {
    configId: "cfg-c",
    indexKey: "sp500" as const,
    dailyValues: [1, 1.1, 1.2],
    timestamps: timestamps.slice(0, 3),
  };
  const degenerateWindow: RollingWindow = {
    startIdx: 1,
    endIdx: 1,
    startDate: dates[1],
    endDate: dates[1],
    lastRealEndDate: dates[1],
    usesSyntheticTail: false,
  };

  const buckets = buildSimulationBuckets([precomputed], [degenerateWindow], dummyPrices.slice(0, 3));
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].simulations.length, 0);
});

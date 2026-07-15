import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSTANT_INITIAL_INVESTMENT,
} from "../src/lib/constants";
import {
  computeEntryAdjustedFactor,
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  getRangeTradeCount,
  getRangeTradeValueSum,
  renormalizeSeriesFromIndex,
  resolveEdgeRiskOffStates,
  selectEdgeSpreads,
} from "../src/lib/simulation/window-calculations";

test("range trade helpers use prefix arrays when present", () => {
  const precomputed = {
    dailyValues: [100, 120, 110, 130],
    tradeDayIndices: [0, 3],
    tradeCountPrefix: Uint32Array.from([0, 0, 1, 1, 2]),
    tradeValuePrefix: Float64Array.from([0, 0, 120, 120, 250]),
  };

  assert.equal(getRangeTradeCount(precomputed, 1, 3), 2);
  assert.equal(getRangeTradeValueSum(precomputed, 1, 3), 250);
});

test("range trade helpers fall back to sorted trade indices", () => {
  const precomputed = {
    dailyValues: [100, 120, 110, 130],
    tradeDayIndices: [0, 3],
  };

  assert.equal(getRangeTradeCount(precomputed, 1, 3), 1);
  assert.equal(getRangeTradeValueSum(precomputed, 1, 3), 130);
});

test("renormalized path metrics compute final value and drawdown", () => {
  const metrics = computeRenormalizedPathMetrics([50, 100, 75, 150], 0, 3);

  assert.notEqual(metrics, null);
  assert.equal(metrics!.factor, CONSTANT_INITIAL_INVESTMENT / 50);
  assert.equal(metrics!.finalValue, 3);
  assert.equal(metrics!.peak, 3);
  assert.equal(metrics!.maxDrawdownPct, 0.25);
});

test("optional non-leveraged metrics default to initial investment", () => {
  const metrics = computeOptionalNonLeveragedMetrics(undefined, 0, 3);

  assert.equal(metrics.finalValue, CONSTANT_INITIAL_INVESTMENT);
  assert.equal(metrics.peak, CONSTANT_INITIAL_INVESTMENT);
  assert.equal(metrics.maxDrawdownPct, 0);
});

test("renormalized path metrics fold entry spread into the rebasing factor", () => {
  const noEntry = computeRenormalizedPathMetrics([50, 100, 75, 150], 0, 3);
  const withEntry = computeRenormalizedPathMetrics([50, 100, 75, 150], 0, 3, 0.01);

  assert.notEqual(withEntry, null);
  // Entry spread rebases day 0 to (1 - entrySpread) instead of 1, then the
  // rest of the path compounds off that reduced basis.
  assert.equal(withEntry!.factor, (CONSTANT_INITIAL_INVESTMENT * 0.99) / 50);
  assert.equal(withEntry!.finalValue, noEntry!.finalValue * 0.99);
  assert.equal(withEntry!.peak, noEntry!.peak * 0.99);
  // Drawdown % is scale-invariant to a uniform entry discount.
  assert.ok(
    Math.abs(withEntry!.maxDrawdownPct - noEntry!.maxDrawdownPct) < 1e-12,
    `expected ${withEntry!.maxDrawdownPct} to equal ${noEntry!.maxDrawdownPct} within float tolerance`
  );
});

test("computeEntryAdjustedFactor rebases to the entry-discounted initial investment", () => {
  assert.equal(computeEntryAdjustedFactor(50), CONSTANT_INITIAL_INVESTMENT / 50);
  assert.equal(computeEntryAdjustedFactor(50, 0.02), (CONSTANT_INITIAL_INVESTMENT * 0.98) / 50);
});

test("renormalizeSeriesFromIndex rescales a full array from a start offset, folding in entry spread", () => {
  const series = renormalizeSeriesFromIndex([10, 20, 40, 80, 100], 1, 0.05);
  const factor = (CONSTANT_INITIAL_INVESTMENT * 0.95) / 20;

  assert.deepEqual(series, [20, 40, 80, 100].map((v) => v * factor));
});

test("renormalizeSeriesFromIndex returns the raw slice when the anchor value is non-finite or zero", () => {
  assert.deepEqual(renormalizeSeriesFromIndex([0, 10, 20], 0), [0, 10, 20]);
  assert.deepEqual(renormalizeSeriesFromIndex([NaN, 10, 20], 0), [NaN, 10, 20]);
});

test("resolveEdgeRiskOffStates picks the last signal at-or-before each cutoff, falling back to the carried-in regime", () => {
  const signals: Array<{ date: string; type: "buy" | "sell" }> = [
    { date: "2020-01-03", type: "sell" },
    { date: "2020-01-10", type: "buy" },
  ];

  // Both cutoffs land after a signal.
  assert.deepEqual(
    resolveEdgeRiskOffStates(signals, "2020-01-05", "2020-01-15", false),
    { startInRiskOff: true, endInRiskOff: false }
  );

  // No signal before either cutoff — carried-in regime wins for both.
  assert.deepEqual(
    resolveEdgeRiskOffStates(signals, "2020-01-01", "2020-01-02", true),
    { startInRiskOff: true, endInRiskOff: true }
  );

  // A signal exactly on the cutoff date counts (inclusive).
  assert.deepEqual(
    resolveEdgeRiskOffStates(signals, "2020-01-03", "2020-01-03", false),
    { startInRiskOff: true, endInRiskOff: true }
  );
});

test("spread selection and cost finalization share entry and exit math", () => {
  const spreads = selectEdgeSpreads(
    { riskOnSpreadRegular: 0.001, riskOffSpreadRegular: 0.002 },
    true,
    false
  );
  const costs = finalizeTradingCosts({
    rawFinalValue: 1200,
    entrySpread: spreads.entrySpread,
    exitSpread: spreads.exitSpread,
    internalDollarCost: 3,
  });

  assert.deepEqual(spreads, { entrySpread: 0.002, exitSpread: 0.001 });
  assert.equal(costs.entryDollarCost, CONSTANT_INITIAL_INVESTMENT * 0.002);
  assert.equal(costs.exitDollarCost, 1.2);
  assert.equal(costs.totalDollarCost, 4.202);
  assert.equal(costs.finalValue, 1198.8);
  assert.equal(costs.totalTradingCostPct, (4.202 / 1198.8) * 100);
});

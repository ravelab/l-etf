import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSTANT_INITIAL_INVESTMENT,
} from "../src/lib/constants";
import {
  computeOptionalNonLeveragedMetrics,
  computeRenormalizedPathMetrics,
  finalizeTradingCosts,
  getRangeTradeCount,
  getRangeTradeValueSum,
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

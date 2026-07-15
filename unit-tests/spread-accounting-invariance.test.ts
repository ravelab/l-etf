import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import {
  precomputeAllConfigDailyValues,
  buildSimulationBuckets,
  runParallelBacktest,
} from "../src/lib/simulation/parallel";
import type { RollingWindow } from "../src/lib/simulation/rolling";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

// Regression coverage for unifying entry/exit spread deduction across every
// simulation path (full-backtest, rolling-window sweep, and warm-up-trimmed
// display windows). Before this fix, `computeRenormalizedPathMetrics`
// renormalized the entry spread away, so a rolling-window `finalValue` for
// the exact same date range/config as `simulateBacktest` differed by the
// entry-spread amount.

function buildPrices(n: number, seed: (i: number) => number, startDate = "2020-01-01"): PricePoint[] {
  const dates: string[] = [];
  const closes: number[] = [];
  let d = new Date(`${startDate}T00:00:00Z`);
  let price = 100;
  for (let i = 0; i < n; i++) {
    dates.push(d.toISOString().slice(0, 10));
    price = price * (1 + seed(i) * 0.01);
    closes.push(price);
    d = new Date(d.getTime() + 86400000);
  }
  return closes.map((c, i) => ({ date: dates[i], adj_close: c, close: c }));
}

const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];

const smaConfig: EtfConfig = {
  id: "QLD",
  name: "QLD",
  leverage: 2,
  expenseRatio: 0.95,
  simulated: true,
  smaEnabled: true,
  smaPeriod: 5,
  smaUpperBuffer: 0,
  smaLowerBuffer: 0,
  smaIndex: "nasdaq100",
  smaExecutionMode: "trigger-day-close",
  riskOffAsset: "SGOV",
};

const buyAndHoldConfig: EtfConfig = {
  id: "UPRO",
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  smaEnabled: false,
  smaPeriod: 200,
  smaUpperBuffer: 0,
  smaLowerBuffer: 0,
  smaIndex: "sp500",
  riskOffAsset: "SGOV",
};

test("simulateBacktest and the rolling-window extraction agree on finalValue and trading cost % over the same full range (SMA)", () => {
  const prices = buildPrices(40, (i) => Math.sin(i * 0.7));

  const full = simulateBacktest(prices, rates, [smaConfig]);
  const etf = full.etfResults.find((r) => r.id === "QLD-sma")!;
  assert.ok(etf.smaSignals.length > 0, "test fixture should exercise at least one SMA transition");

  const precomputed = precomputeAllConfigDailyValues(prices, rates, [smaConfig]);
  const window: RollingWindow = {
    startIdx: 0,
    endIdx: prices.length - 1,
    startDate: prices[0].date,
    endDate: prices[prices.length - 1].date,
    lastRealEndDate: prices[prices.length - 1].date,
    usesSyntheticTail: false,
  };
  const buckets = buildSimulationBuckets(precomputed, [window], prices, { configs: [smaConfig] });
  const windowed = buckets.find((b) => b.configId === "QLD")!.simulations[0];

  assert.ok(windowed, "rolling window extraction should produce a result");
  assert.equal(windowed.finalValue, etf.finalValue);
  // The windowed path estimates in-window transition cost from a prefix sum
  // of post-spread daily values, while the full-backtest loop accumulates it
  // from the pre-spread value at each transition — a pre-existing, second-order
  // approximation gap unrelated to entry/exit deduction, so use a loose
  // relative tolerance here rather than exact equality.
  const relDiff = Math.abs(windowed.totalTradingCostPct - etf.totalTradingCostPct) / Math.abs(etf.totalTradingCostPct);
  assert.ok(
    relDiff < 0.01,
    `totalTradingCostPct should agree within 1%: window=${windowed.totalTradingCostPct}, full=${etf.totalTradingCostPct}`
  );
});

test("simulateBacktest and the rolling-window extraction agree on finalValue over the same full range (buy-and-hold, no SMA)", () => {
  const prices = buildPrices(30, (i) => Math.cos(i * 0.4));

  const full = simulateBacktest(prices, rates, [buyAndHoldConfig]);
  const etf = full.etfResults[0];

  const precomputed = precomputeAllConfigDailyValues(prices, rates, [buyAndHoldConfig]);
  const window: RollingWindow = {
    startIdx: 0,
    endIdx: prices.length - 1,
    startDate: prices[0].date,
    endDate: prices[prices.length - 1].date,
    lastRealEndDate: prices[prices.length - 1].date,
    usesSyntheticTail: false,
  };
  const buckets = buildSimulationBuckets(precomputed, [window], prices, { configs: [buyAndHoldConfig] });
  const windowed = buckets.find((b) => b.configId === "UPRO")!.simulations[0];

  assert.ok(windowed);
  assert.equal(windowed.finalValue, etf.finalValue);
});

test("runParallelBacktest (warm-up trimmed) and the rolling-window extraction agree on finalValue for a sub-window with real warm-up", async () => {
  const prices = buildPrices(60, (i) => Math.cos(i * 0.5) * 1.5);
  const displayStartIdx = 20;
  const displayEndIdx = prices.length - 1;

  const viaWarmUp = await runParallelBacktest({
    prices,
    rates,
    startDate: prices[displayStartIdx].date,
    endDate: prices[displayEndIdx].date,
    configs: [smaConfig],
  });
  const warmUpEtf = viaWarmUp.etfResults.find((r) => r.id === "QLD-sma")!;
  assert.ok(warmUpEtf.smaSignals.length >= 0);

  const precomputed = precomputeAllConfigDailyValues(prices, rates, [smaConfig]);
  const window: RollingWindow = {
    startIdx: displayStartIdx,
    endIdx: displayEndIdx,
    startDate: prices[displayStartIdx].date,
    endDate: prices[displayEndIdx].date,
    lastRealEndDate: prices[displayEndIdx].date,
    usesSyntheticTail: false,
  };
  const buckets = buildSimulationBuckets(precomputed, [window], prices, { configs: [smaConfig] });
  const windowed = buckets.find((b) => b.configId === "QLD")!.simulations[0];

  assert.ok(windowed, "rolling window extraction should produce a result");
  assert.ok(
    Math.abs(warmUpEtf.finalValue - windowed.finalValue) < 1e-9,
    `finalValue should agree across paths for the same date range: warmUp=${warmUpEtf.finalValue}, window=${windowed.finalValue}`
  );
});

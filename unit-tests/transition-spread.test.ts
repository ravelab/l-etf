import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import { getSymbolSpread, getRiskOffSpread } from "../src/lib/constants";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

// Rising prices, then a crash below the 2-day SMA on day 3 that never
// recovers above it: exactly one sell signal (day 3), no re-entry.
const prices: PricePoint[] = [
  { date: "2020-01-01", adj_close: 100, adj_open: 99.5, close: 1000 },
  { date: "2020-01-02", adj_close: 101, adj_open: 100.4, close: 1010 },
  { date: "2020-01-03", adj_close: 102, adj_open: 101.5, close: 1020 },
  { date: "2020-01-06", adj_close: 90, adj_open: 101.8, close: 900 },
  { date: "2020-01-07", adj_close: 89, adj_open: 89.6, close: 890 },
  { date: "2020-01-08", adj_close: 88, adj_open: 88.9, close: 880 },
];

const zeroRates: RatePoint[] = [
  { date: "2020-01-01", rateValue: 0, rateType: "borrow" },
];

const baseConfig: Omit<EtfConfig, "id"> = {
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  smaEnabled: true,
  smaPeriod: 2,
  smaUpperBuffer: 0,
  smaLowerBuffer: 0,
  smaIndex: "sp500",
  riskOffAsset: "SGOV",
};

function smaVariant(result: ReturnType<typeof simulateBacktest>) {
  const etf = result.etfResults.find((r) => r.id.endsWith("-sma"));
  assert.notEqual(etf, undefined, "expected an SMA variant in the results");
  return etf!;
}

test("transition spread is invariant to config id (name is the spread source)", () => {
  // Same strategy, ids shaped like the Strategies page ("UPRO-sma") vs a
  // sweep page ("buffer-2.5"). The simulated path must be identical: the
  // per-transition spread is resolved from config.name, never config.id.
  const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];
  const strategiesStyle: EtfConfig = {
    ...baseConfig,
    id: "UPRO-sma",
    smaExecutionMode: "trigger-day-close",
  };
  const sweepStyle: EtfConfig = {
    ...baseConfig,
    id: "buffer-2.5",
    smaExecutionMode: "trigger-day-close",
  };

  // Two separate runs: identical configs (modulo id) inside one run would
  // be collapsed by the engine's dedupe step.
  const a = smaVariant(simulateBacktest(prices, rates, [strategiesStyle]));
  const b = smaVariant(simulateBacktest(prices, rates, [sweepStyle]));

  assert.equal(a.dailyValues.length, b.dailyValues.length);
  for (let i = 0; i < a.dailyValues.length; i++) {
    assert.equal(
      a.dailyValues[i],
      b.dailyValues[i],
      `dailyValues diverge at index ${i} (${prices[i].date}): ${a.dailyValues[i]} vs ${b.dailyValues[i]}`
    );
  }
  assert.equal(a.finalValue, b.finalValue);
});

// Leverage 1, ER 0, borrow rate 0 make the simulated risk-on return equal the
// index return exactly, so transition-day values can be hand-computed.
const unleveragedConfig: Omit<EtfConfig, "id" | "smaExecutionMode"> = {
  ...baseConfig,
  leverage: 1,
  expenseRatio: 0,
};

test("trigger-day-close transition deducts the full after-hours spread from the name-resolved ticker", () => {
  const config: EtfConfig = {
    ...unleveragedConfig,
    id: "buffer-2.5", // sweep-style id: carries no ticker
    smaExecutionMode: "trigger-day-close",
  };
  const etf = smaVariant(simulateBacktest(prices, zeroRates, [config]));

  // Sell signal on day 3 executes at day 3's close: day 3 earns the risk-on
  // return, then the transition deducts the after-hours round-trip spread.
  const transitionIdx = 3;
  const dayReturn =
    (prices[transitionIdx].adj_close - prices[transitionIdx - 1].adj_close) /
    prices[transitionIdx - 1].adj_close;
  const baseValue = etf.dailyValues[transitionIdx - 1] * (1 + dayReturn);
  const spread =
    getSymbolSpread(config.name, true) + getRiskOffSpread(config.riskOffAsset, true);
  const expected = baseValue * (1 - spread);

  assert.ok(
    Math.abs(etf.dailyValues[transitionIdx] - expected) < 1e-12,
    `expected ${expected}, got ${etf.dailyValues[transitionIdx]}`
  );
});

test("next-day-open transition deducts the full regular-hours spread from the name-resolved ticker", () => {
  const config: EtfConfig = {
    ...unleveragedConfig,
    id: "buffer-2.5", // sweep-style id: carries no ticker
    smaExecutionMode: "next-day-open",
  };
  const etf = smaVariant(simulateBacktest(prices, zeroRates, [config]));

  // Sell signal on day 3 executes at day 4's open: day 4 earns the overnight
  // risk-on return (prev close -> open), then the transition deducts the
  // regular-hours round-trip spread.
  const transitionIdx = 4;
  const overnightReturn =
    (prices[transitionIdx].adj_open as number) / prices[transitionIdx - 1].adj_close - 1;
  const baseValue = etf.dailyValues[transitionIdx - 1] * (1 + overnightReturn);
  const spread =
    getSymbolSpread(config.name, false) + getRiskOffSpread(config.riskOffAsset, false);
  const expected = baseValue * (1 - spread);

  assert.ok(
    Math.abs(etf.dailyValues[transitionIdx] - expected) < 1e-12,
    `expected ${expected}, got ${etf.dailyValues[transitionIdx]}`
  );
});

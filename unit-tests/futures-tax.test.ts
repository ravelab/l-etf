import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FUTURES_TAX_RATES, estimateFuturesAfterTaxCagr, futuresTaxRate } from "../src/lib/simulation/futures-tax";
import { calcCagr } from "../src/lib/simulation/metrics";

const defaults = DEFAULT_FUTURES_TAX_RATES;
const zero = { ltcg: 0, stcg: 0, state: 0, medicare: 0 };
const dates = ["2020-01-01", "2020-12-31", "2021-12-31"];
const near = (actual: number | undefined, expected: number) => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
};

test("Section 1256 defaults blend to 29.6%, with each input contributing", () => {
  near(futuresTaxRate(defaults), 0.296);
  near(futuresTaxRate({ ...zero, ltcg: 10 }), 0.06);
  near(futuresTaxRate({ ...zero, stcg: 10 }), 0.04);
  near(futuresTaxRate({ ...zero, state: 10 }), 0.1);
  near(futuresTaxRate({ ...zero, medicare: 3.8 }), 0.038);
  near(futuresTaxRate({ ltcg: 100, stcg: 100, state: 100, medicare: 100 }), 1);
});

test("zero rates preserve pretax CAGR including entry costs", () => {
  near(estimateFuturesAfterTaxCagr(dates, [99, 120, 144], 100, zero), calcCagr(100, 144, dates[0], dates[2]));
});

test("year-end payments reduce the capital compounding in later years", () => {
  const end = 100 * (1 + 0.2 * (1 - 0.296)) ** 2;
  near(estimateFuturesAfterTaxCagr(dates, [100, 120, 144], 100, defaults), calcCagr(100, end, dates[0], dates[2]));
});

test("annual losses carry forward without refunds and offset later gains", () => {
  near(estimateFuturesAfterTaxCagr(dates, [100, 80, 120], 100, defaults), calcCagr(100, 120 - 20 * 0.296, dates[0], dates[2]));
  near(estimateFuturesAfterTaxCagr(dates, [100, 80, 100], 100, defaults), 0);
});

test("taxes apply to nominal gains even if inflation would erase the real gain", () => {
  near(estimateFuturesAfterTaxCagr(["2020-01-01", "2020-07-01"], [100, 110], 100, defaults), calcCagr(100, 107.04, "2020-01-01", "2020-07-01"));
});

test("uses the last session per year, taxes the final partial year, and includes costs", () => {
  const days = ["2020-06-01", "2020-12-30", "2021-01-04", "2021-06-01"];
  near(estimateFuturesAfterTaxCagr(days, [99, 110, 121, 121], 100, defaults), calcCagr(100, (110 - 10 * 0.296) * 1.0704, days[0], days[3]));
});

test("handles ruin and unavailable series", () => {
  assert.equal(estimateFuturesAfterTaxCagr(dates, [100, 0, 0], 100, defaults), -100);
  assert.equal(estimateFuturesAfterTaxCagr([], [], 100, defaults), undefined);
  assert.equal(estimateFuturesAfterTaxCagr(dates, [100], 100, defaults), undefined);
  assert.equal(estimateFuturesAfterTaxCagr(dates, [0, 0, 0], 0, defaults), undefined);
});

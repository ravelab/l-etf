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

test("a first year owes no estimates; its tax is paid in April with the next year's first installment", () => {
  const days = ["2020-01-02", "2020-12-31", "2021-04-15", "2021-06-15", "2021-09-15", "2021-12-31", "2022-01-14"];
  const tax2020 = 20 * 0.296;
  const installment = (1.1 * tax2020) / 4;
  // Apr 15: the 2020 balance plus the first 2021 installment; then Jun and Sep.
  const beforeGrowth = 120 - tax2020 - 3 * installment;
  const afterGrowth = beforeGrowth * 1.5;
  const tax2021 = (afterGrowth - beforeGrowth) * 0.296;
  // The run ends before the Jan 15 installment: 2021's balance settles from the close.
  const end = afterGrowth - (tax2021 - 3 * installment);
  near(estimateFuturesAfterTaxCagr(days, [100, 120, 120, 120, 120, 180, 180], 100, defaults), calcCagr(100, end, days[0], days[6]));
});

test("estimates beyond the year's tax are refunded at the April true-up", () => {
  const days = ["2020-01-02", "2020-12-31", "2021-04-15", "2021-06-15", "2021-09-15", "2021-12-31", "2022-01-18", "2022-04-18", "2022-05-02"];
  // 2021 earns nothing, so its four installments all come back in April 2022.
  near(
    estimateFuturesAfterTaxCagr(days, [100, 120, 120, 120, 120, 120, 120, 120, 120], 100, defaults),
    calcCagr(100, 120 - 20 * 0.296, days[0], days[8]),
  );
});

test("annual losses carry forward without refunds and offset later gains", () => {
  near(estimateFuturesAfterTaxCagr(dates, [100, 80, 120], 100, defaults), calcCagr(100, 120 - 20 * 0.296, dates[0], dates[2]));
  near(estimateFuturesAfterTaxCagr(dates, [100, 80, 100], 100, defaults), 0);
});

test("taxes apply to nominal gains even if inflation would erase the real gain", () => {
  near(estimateFuturesAfterTaxCagr(["2020-01-01", "2020-07-01"], [100, 110], 100, defaults), calcCagr(100, 107.04, "2020-01-01", "2020-07-01"));
});

test("uses the last session per year, settles everything owed at the end, and includes costs", () => {
  const days = ["2020-06-01", "2020-12-30", "2021-01-04", "2021-03-01"];
  // No due date passes before the end: 2020's 2.96 and 2021's 3.256 both settle from the close.
  near(estimateFuturesAfterTaxCagr(days, [99, 110, 121, 121], 100, defaults), calcCagr(100, 121 - 2.96 - 3.256, days[0], days[3]));
});

test("handles ruin and unavailable series", () => {
  assert.equal(estimateFuturesAfterTaxCagr(dates, [100, 0, 0], 100, defaults), -100);
  assert.equal(estimateFuturesAfterTaxCagr([], [], 100, defaults), undefined);
  assert.equal(estimateFuturesAfterTaxCagr(dates, [100], 100, defaults), undefined);
  assert.equal(estimateFuturesAfterTaxCagr(dates, [0, 0, 0], 0, defaults), undefined);
});

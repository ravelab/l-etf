import test from "node:test";
import assert from "node:assert/strict";
import { buildRateLookup } from "../src/lib/simulation/borrowing-rate";
import type { RatePoint } from "../src/lib/simulation/types";

test("buildRateLookup find exact matches", () => {
  const rates: RatePoint[] = [
    { date: "2020-01-01", rateValue: 0.05, rateType: "test" },
    { date: "2020-01-02", rateValue: 0.06, rateType: "test" },
  ];
  const lookup = buildRateLookup(rates);
  assert.equal(lookup.getRate("2020-01-01"), 0.05 / 360);
  assert.equal(lookup.getRate("2020-01-02"), 0.06 / 360);
});

test("buildRateLookup forward-fills for missing dates", () => {
  const rates: RatePoint[] = [
    { date: "2020-01-01", rateValue: 0.05, rateType: "test" },
    { date: "2020-01-05", rateValue: 0.10, rateType: "test" },
  ];
  const lookup = buildRateLookup(rates);
  // Jan 02, 03, 04 should use Jan 01 rate
  assert.equal(lookup.getRate("2020-01-02"), 0.05 / 360);
  assert.equal(lookup.getRate("2020-01-04"), 0.05 / 360);
  assert.equal(lookup.getRate("2020-01-05"), 0.10 / 360);
});

test("buildRateLookup throws for dates before rate data starts", () => {
  const rates: RatePoint[] = [
    { date: "2020-01-01", rateValue: 0.05, rateType: "test" },
  ];
  const lookup = buildRateLookup(rates);
  assert.throws(
    () => lookup.getRate("2019-12-31"),
    /Borrowing rate data is missing for 2019-12-31/
  );
});

test("buildRateLookup matches YYYY-MM keys", () => {
  const rates: RatePoint[] = [
    { date: "2020-01", rateValue: 0.05, rateType: "test" },
  ];
  const lookup = buildRateLookup(rates);
  assert.equal(lookup.getRate("2020-01-15"), 0.05 / 360);
});

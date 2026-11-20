import test from "node:test";
import assert from "node:assert/strict";

import {
  SHORT_GOV_YIELD_START_MONTH,
  SHORT_TREASURY_YIELD_NAMES,
  TB3MS_START_MONTH,
  composeShortTreasuryYieldsByMonth,
} from "../scripts/lib/short-treasury-yields";

const inputs = {
  // The upstream column is the Shiller 10-year minus 1% before 1926, then a quantized bill.
  upstreamRiskFreeByMonth: new Map([
    ["1919-12", 0.0373],
    ["1920-01", 0.0397],
    ["1932-05", 0],
  ]),
  shortGovPctByMonth: new Map([
    ["1920-01", 4.5],
    ["1932-05", 0.43],
    ["1933-12", 0.7],
    ["1934-01", 0.72],
  ]),
  tb3msPctByMonth: new Map([
    ["1934-01", 0.72],
    ["1976-05", 5.21],
  ]),
};

test("source switch months", () => {
  assert.equal(SHORT_GOV_YIELD_START_MONTH, "1920-01");
  assert.equal(TB3MS_START_MONTH, "1934-01");
});

test("upstream only before 1920, NBER short governments to 1933, TB3MS after", () => {
  const rows = composeShortTreasuryYieldsByMonth(inputs);
  assert.deepEqual(rows, [
    { date: "1919-12", value: 0.0373, name: SHORT_TREASURY_YIELD_NAMES.upstream },
    { date: "1920-01", value: 0.045, name: SHORT_TREASURY_YIELD_NAMES.shortGov },
    { date: "1932-05", value: 0.0043, name: SHORT_TREASURY_YIELD_NAMES.shortGov },
    { date: "1933-12", value: 0.7 / 100, name: SHORT_TREASURY_YIELD_NAMES.shortGov },
    { date: "1934-01", value: 0.0072, name: SHORT_TREASURY_YIELD_NAMES.tb3ms },
    { date: "1976-05", value: 0.0521, name: SHORT_TREASURY_YIELD_NAMES.tb3ms },
  ]);
});

test("throws when a source does not reach its segment", () => {
  assert.throws(
    () => composeShortTreasuryYieldsByMonth({ ...inputs, shortGovPctByMonth: new Map() }),
    /short-term government/i
  );
  assert.throws(
    () => composeShortTreasuryYieldsByMonth({ ...inputs, tb3msPctByMonth: new Map() }),
    /TB3MS/
  );
});

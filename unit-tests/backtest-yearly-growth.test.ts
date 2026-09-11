import test from "node:test";
import assert from "node:assert/strict";
import { buildBacktestYearlyGrowthSeries } from "@/lib/backtest-yearly-growth";

/** December CPI observations at a flat 2%/yr, so every year carries inflation. */
const MONTHLY_CPI = [
  { date: "2000-12-31", value: 100 },
  { date: "2001-12-31", value: 102 },
  { date: "2002-12-31", value: 104.04 },
  { date: "2003-12-31", value: 106.1208 },
];

/** Year-end marks only; the first year is a single point and so yields no growth row. */
const LONG_DATES = ["2000-12-29", "2001-12-31", "2002-12-31", "2003-12-31"];
const SHORT_DATES = ["2001-12-31", "2002-12-31", "2003-12-31"];

test("buildBacktestYearlyGrowthSeries: spans the union of every series' years", () => {
  const built = buildBacktestYearlyGrowthSeries({
    series: [
      { label: "UPRO SMA", dates: LONG_DATES, values: [100, 110, 121, 133.1] },
      { label: "QLD SMA", dates: SHORT_DATES, values: [100, 120, 144] },
    ],
    monthlyCpi: MONTHLY_CPI,
  });
  assert.ok(built);
  assert.deepEqual(built.years, ["2001", "2002", "2003"]);
});

test("buildBacktestYearlyGrowthSeries: pads a late-starting series with null, never shifts it", () => {
  const built = buildBacktestYearlyGrowthSeries({
    series: [
      { label: "UPRO SMA", dates: LONG_DATES, values: [100, 110, 121, 133.1] },
      { label: "QLD SMA", dates: SHORT_DATES, values: [100, 120, 144] },
    ],
    monthlyCpi: MONTHLY_CPI,
  });
  assert.ok(built);
  const short = built.series.find((s) => s.label === "QLD SMA");
  assert.ok(short);
  assert.equal(short.values.length, built.years.length);
  // QLD has no 2001 row of its own, so 2001 must be blank rather than its 2002 value.
  assert.equal(short.values[0], null);
  assert.equal(typeof short.values[1], "number");
  assert.equal(typeof short.values[2], "number");
});

test("buildBacktestYearlyGrowthSeries: keeps series order and labels as given", () => {
  const built = buildBacktestYearlyGrowthSeries({
    series: [
      { label: "SSO SMA", dates: LONG_DATES, values: [100, 110, 121, 133.1] },
      { label: "SSO", dates: LONG_DATES, values: [100, 105, 110.25, 115.76] },
      { label: "VOO", dates: LONG_DATES, values: [100, 103, 106.09, 109.27] },
    ],
    monthlyCpi: MONTHLY_CPI,
  });
  assert.ok(built);
  assert.deepEqual(
    built.series.map((s) => s.label),
    ["SSO SMA", "SSO", "VOO"]
  );
});

test("buildBacktestYearlyGrowthSeries: carries one inflation row covering every year", () => {
  const built = buildBacktestYearlyGrowthSeries({
    series: [{ label: "QLD SMA", dates: SHORT_DATES, values: [100, 120, 144] }],
    monthlyCpi: MONTHLY_CPI,
  });
  assert.ok(built);
  assert.equal(built.inflation?.length, built.years.length);
  for (const value of built.inflation ?? []) {
    assert.equal(typeof value, "number");
  }
});

test("buildBacktestYearlyGrowthSeries: returns null when nothing has a full year", () => {
  assert.equal(buildBacktestYearlyGrowthSeries({ series: [], monthlyCpi: MONTHLY_CPI }), null);
  assert.equal(
    buildBacktestYearlyGrowthSeries({
      series: [{ label: "UPRO SMA", dates: ["2003-12-31"], values: [100] }],
      monthlyCpi: MONTHLY_CPI,
    }),
    null
  );
});

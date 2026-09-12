import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBacktestYearlyGrowthSeries,
  collectBacktestGrowthSeries,
} from "@/lib/backtest-yearly-growth";
import type { EtfResult } from "@/lib/simulation/types";

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
  // Non-zero, not merely numeric: an empty CPI series silently yields 0.00% on every
  // row and turns the whole table nominal, which is exactly how it shipped broken.
  for (const value of built.inflation ?? []) {
    assert.ok(
      typeof value === "number" && value > 0.015 && value < 0.025,
      `expected roughly 2%/yr inflation, got ${value}`
    );
  }
});

test("buildBacktestYearlyGrowthSeries: subtracts inflation, so growth is real not nominal", () => {
  const series = [{ label: "QLD SMA", dates: SHORT_DATES, values: [100, 120, 144] }];
  const real = buildBacktestYearlyGrowthSeries({ series, monthlyCpi: MONTHLY_CPI });
  // No CPI at all is the degenerate case: growth then has to come back nominal.
  const nominal = buildBacktestYearlyGrowthSeries({ series, monthlyCpi: [] });
  assert.ok(real && nominal);

  const realValue = real.series[0].values.at(-1);
  const nominalValue = nominal.series[0].values.at(-1);
  assert.ok(typeof realValue === "number" && typeof nominalValue === "number");
  assert.ok(
    realValue < nominalValue - 1,
    `real ${realValue} should sit clearly below nominal ${nominalValue}`
  );
  // 20% nominal against 2% inflation is ~17.6% real.
  assert.ok(Math.abs(realValue - 17.6) < 0.5, `expected ~17.6% real, got ${realValue}`);
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

/** Only the fields the collector reads; the rest of EtfResult is irrelevant here. */
function etfResult(id: string, name: string, sourceIndex: "sp500" | "nasdaq100"): EtfResult {
  return {
    id,
    name,
    sourceIndex,
    dates: LONG_DATES,
    dailyValues: [100, 110, 121, 133.1],
  } as unknown as EtfResult;
}

const INDEX_SERIES = [
  { index: "sp500", label: "VOO", dates: LONG_DATES, values: [100, 103, 106.09, 109.27] },
  { index: "nasdaq100", label: "QQQ", dates: LONG_DATES, values: [100, 104, 108.16, 112.49] },
];

test("collectBacktestGrowthSeries: groups by family, SMA first, index closing the group", () => {
  const rows = collectBacktestGrowthSeries({
    result: {
      etfResults: [
        etfResult("etf1-base", "UPRO (No SMA)", "sp500"),
        etfResult("etf2-sma", "TQQQ (SMA, SGOV)", "nasdaq100"),
        etfResult("etf1-sma", "UPRO (SMA, SGOV)", "sp500"),
        etfResult("etf2-base", "TQQQ (No SMA)", "nasdaq100"),
      ],
    },
    underlyingIndexSeries: INDEX_SERIES,
  });
  assert.deepEqual(
    rows.map((r) => r.label),
    ["UPRO SMA", "UPRO", "VOO", "TQQQ SMA", "TQQQ", "QQQ"]
  );
});

test("collectBacktestGrowthSeries: reports every family the result holds", () => {
  // The page's own configs used to select these rows while the data came from the
  // result. Switching the preset to an SPX-only LETF without re-running then made
  // the NDX columns vanish from a result that still contained them.
  const rows = collectBacktestGrowthSeries({
    result: {
      etfResults: [
        etfResult("etf1-sma", "UPRO (SMA, SGOV)", "sp500"),
        etfResult("etf2-sma", "TQQQ (SMA, SGOV)", "nasdaq100"),
      ],
    },
    underlyingIndexSeries: INDEX_SERIES,
  });
  assert.deepEqual(rows.map((r) => r.label), ["UPRO SMA", "VOO", "TQQQ SMA", "QQQ"]);
});

test("collectBacktestGrowthSeries: omits an index row it was given no series for", () => {
  const rows = collectBacktestGrowthSeries({
    result: { etfResults: [etfResult("etf1-sma", "SSO (SMA, SGOV)", "sp500")] },
    underlyingIndexSeries: [],
  });
  assert.deepEqual(rows.map((r) => r.label), ["SSO SMA"]);
});

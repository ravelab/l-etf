import test from "node:test";
import assert from "node:assert/strict";
import {
  buildYearlyCpiInflation,
  annualizedInflationForRange,
  cpiIndexRatioEndOverStart,
  displayedAnnualizedInflationPct,
  inflationPctForSweepSectionTitle,
  sampleYearlyRealGrowth
} from "@/lib/inflation";

const cpiSeries = [
  { date: "2020-06-01", value: 100 },
  { date: "2021-06-01", value: 105 },
  { date: "2022-06-01", value: 110.25 },
];

test("buildYearlyCpiInflation computes year-over-year rates from last CPI per year", () => {
  const map = buildYearlyCpiInflation(cpiSeries);
  assert.ok(Math.abs((map.get("2021") ?? 0) - 0.05) < 1e-9);
  assert.ok(Math.abs((map.get("2022") ?? 0) - 0.05) < 1e-9);
  assert.equal(map.has("2020"), false);
});

test("buildYearlyCpiInflation returns empty map for fewer than 2 data points", () => {
  assert.equal(buildYearlyCpiInflation([]).size, 0);
  assert.equal(buildYearlyCpiInflation([{ date: "2020-01-01", value: 100 }]).size, 0);
});

test("buildYearlyCpiInflation uses the last observation per year when multiple exist", () => {
  const monthly = [
    { date: "2020-01-01", value: 100 },
    { date: "2020-06-01", value: 102 },
    { date: "2020-12-01", value: 104 }, // last for 2020
    { date: "2021-12-01", value: 109.2 }, // last for 2021
  ];
  const map = buildYearlyCpiInflation(monthly);
  const rate2021 = map.get("2021") ?? 0;
  assert.ok(Math.abs(rate2021 - (109.2 - 104) / 104) < 1e-9);
});

test("annualizedInflationForRange returns 0 for fewer than 2 CPI points", () => {
  assert.equal(annualizedInflationForRange([], "2020-01-01", "2022-01-01"), 0);
  assert.equal(
    annualizedInflationForRange(
      [{ date: "2020-01-01", value: 100 }],
      "2020-01-01",
      "2022-01-01",
    ),
    0,
  );
});

test("cpiIndexRatioEndOverStart is CPI_end / CPI_start for nearest observations", () => {
  const cpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2025-01-01", value: 121 },
  ];
  const ratio = cpiIndexRatioEndOverStart(cpi, "2020-06-15", "2025-06-15");
  assert.ok(Math.abs(ratio - 121 / 100) < 1e-9);
  assert.equal(cpiIndexRatioEndOverStart([], "2020-01-01", "2025-01-01"), 1);
});

test("annualizedInflationForRange annualizes CPI growth correctly", () => {
  const cpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2022-01-01", value: 110.25 },
  ];
  const rate = annualizedInflationForRange(cpi, "2020-01-01", "2022-01-01");

  // Compute expected rate using the same year formula the function uses
  const startMs = new Date("2020-01-01").getTime();
  const endMs = new Date("2022-01-01").getTime();
  const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000);
  const expected = Math.pow(110.25 / 100, 1 / years) - 1;

  assert.ok(Math.abs(rate - expected) < 1e-9);
  // Should be close to 5% annualized
  assert.ok(Math.abs(rate - 0.05) < 0.001);
});

test("annualizedInflationForRange annualizes over the CPI observation span, not past it", () => {
  const cpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2021-01-01", value: 105 },
  ];
  // endDate is months after the last CPI observation. The 5% CPI growth
  // happened over one calendar year (366 days — 2020 is a leap year), so it
  // must annualize over that span — stretching to endDate would dilute it
  // to ~3.4%.
  const rate = annualizedInflationForRange(cpi, "2020-01-01", "2021-06-15");
  const expected = Math.pow(1.05, 1 / (366 / 365.25)) - 1;
  assert.ok(Math.abs(rate - expected) < 1e-9, `expected ${expected}, got ${rate}`);
});

test("annualizedInflationForRange returns 0 when start equals end date", () => {
  const cpi = [{ date: "2020-01-01", value: 100 }, { date: "2021-01-01", value: 103 }];
  const rate = annualizedInflationForRange(cpi, "2021-01-01", "2021-01-01");
  assert.equal(rate, 0);
});

test("annualizedInflationForRange uses earliest CPI when startDate predates data", () => {
  const cpi = [
    { date: "2015-01-01", value: 100 },
    { date: "2020-01-01", value: 120 },
  ];
  // startDate before first CPI observation — should fall back to first CPI
  const rate = annualizedInflationForRange(cpi, "2010-01-01", "2020-01-01");
  assert.ok(rate > 0);
});

test("displayedAnnualizedInflationPct formats properly", () => {
  const cpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2021-01-01", value: 110 },
  ];
  assert.equal(Math.abs(displayedAnnualizedInflationPct(cpi, "2020-01-01", "2021-01-01") - 10) < 0.1, true);
  // Uses fallback annualizedInflation when cpi is empty
  assert.equal(displayedAnnualizedInflationPct([], "2020-01-01", "2021-01-01", 0.05), 5);
});

test("inflationPctForSweepSectionTitle uses correct start date", () => {
  const cpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2021-01-01", value: 110 },
  ];
  const pct1 = inflationPctForSweepSectionTitle({
    monthlyCpi: cpi,
    sectionDisplayStartDate: "2020-01-01",
    fallbackStartDate: "1990-01-01",
    cpiEndDate: "2021-01-01",
    annualizedInflation: 0.05
  });
  assert.equal(Math.abs(pct1! - 10) < 0.1, true);

  const pct2 = inflationPctForSweepSectionTitle({
    monthlyCpi: [],
    sectionDisplayStartDate: null,
    fallbackStartDate: "1990-01-01",
    cpiEndDate: "2021-01-01",
    annualizedInflation: 0.05
  });
  assert.equal(Math.abs(pct2! - 5) < 0.0001, true);
});

test("sampleYearlyRealGrowth calculates correctly", () => {
  const dates = ["2020-12-01", "2021-12-01", "2022-12-01"];
  const values = [100, 110, 121]; // 10% nominal each year
  const cpi = new Map([
    ["2020", 0.02],
    ["2021", 0.02], // 2% inflation
    ["2022", 0.02], // 2% inflation
  ]);
  const res = sampleYearlyRealGrowth(dates, values, cpi);
  assert.deepEqual(res.years, ["2021", "2022"]);
  // Nominal return = 0.1, inflation = 0.02. Real return = 1.1 / 1.02 - 1 = 0.07843 -> 7.843%
  assert.equal(Math.abs(res.values[0] - 7.8431) < 0.001, true);
  assert.equal(Math.abs(res.values[1] - 7.8431) < 0.001, true);
  assert.deepEqual(res.inflation, [0.02, 0.02]);
});

test("sampleYearlyRealGrowth with monthly CPI fallback", () => {
  const dates = ["2020-12-01", "2021-12-01"];
  const values = [100, 110];
  const monthlyCpi = [
    { date: "2020-12-01", value: 100 },
    { date: "2021-12-01", value: 105 },
  ];
  const res = sampleYearlyRealGrowth(dates, values, new Map(), monthlyCpi);
  assert.deepEqual(res.years, ["2021"]);
  // Nominal return = 0.1, inflation = 105/100 - 1 = 0.05. Real = 1.1 / 1.05 - 1 = 0.0476
  assert.equal(Math.abs(res.values[0] - 4.7619) < 0.001, true);
  assert.equal(res.inflation.length, 1);
  assert.equal(Math.abs(res.inflation[0] - 0.05) < 1e-9, true);
});

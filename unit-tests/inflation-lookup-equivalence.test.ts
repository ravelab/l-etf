import test from "node:test";
import assert from "node:assert/strict";
import {
  annualizedInflationForRange,
  cpiIndexRatioEndOverStart,
} from "../src/lib/inflation";

type Obs = { date: string; value: number };

// Verbatim reimplementation of the pre-optimization linear scan, so the
// binary-search path can be proven equivalent rather than merely plausible.
function referenceAnnualized(monthlyCpi: Obs[], startDate: string, endDate: string): number {
  if (monthlyCpi.length < 2) return 0;
  let startCpi = NaN, startCpiDate = startDate, endCpi = NaN, endCpiDate = endDate;
  for (const obs of monthlyCpi) {
    if (obs.date <= startDate) { startCpi = obs.value; startCpiDate = obs.date; }
    if (obs.date <= endDate) { endCpi = obs.value; endCpiDate = obs.date; }
  }
  if (isNaN(startCpi) && monthlyCpi.length > 0) {
    startCpi = monthlyCpi[0].value;
    startCpiDate = monthlyCpi[0].date;
  }
  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0) return 0;
  const years =
    (new Date(endCpiDate).getTime() - new Date(startCpiDate).getTime()) /
    (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return 0;
  return Math.pow(endCpi / startCpi, 1 / years) - 1;
}

function referenceRatio(monthlyCpi: Obs[], startDate: string, endDate: string): number {
  if (monthlyCpi.length < 2 || endDate < startDate) return 1;
  let startCpi = NaN, endCpi = NaN;
  for (const obs of monthlyCpi) {
    if (obs.date <= startDate) startCpi = obs.value;
    if (obs.date <= endDate) endCpi = obs.value;
  }
  if (isNaN(startCpi) && monthlyCpi.length > 0) startCpi = monthlyCpi[0].value;
  if (isNaN(startCpi) || isNaN(endCpi) || startCpi <= 0 || endCpi <= 0) return 1;
  return endCpi / startCpi;
}

function monthlySeries(): Obs[] {
  const out: Obs[] = [];
  let v = 30;
  for (let year = 1960; year <= 2026; year++) {
    for (let m = 1; m <= 12; m++) {
      v *= 1 + ((year % 7) + m) / 4000;
      out.push({ date: `${year}-${String(m).padStart(2, "0")}-01`, value: v });
    }
  }
  return out;
}

test("binary-search CPI lookup matches the original linear scan exactly", () => {
  const cpi = monthlySeries();
  const probes = [
    // before the series, at the exact first/last obs, mid-month, after the end
    ["1900-01-01", "1950-06-15"],
    ["1900-01-01", "2026-12-01"],
    ["1960-01-01", "1960-01-01"],
    ["1960-01-01", "2026-12-31"],
    ["1973-11-15", "1982-07-02"],
    ["2007-10-09", "2009-03-09"],
    ["2026-12-01", "2026-12-01"],
    ["2030-01-01", "2030-06-01"],
    ["1999-12-31", "1999-01-01"], // end before start
  ] as const;

  for (const [start, end] of probes) {
    assert.equal(
      annualizedInflationForRange(cpi, start, end),
      referenceAnnualized(cpi, start, end),
      `annualized mismatch for ${start}..${end}`
    );
    assert.equal(
      cpiIndexRatioEndOverStart(cpi, start, end),
      referenceRatio(cpi, start, end),
      `ratio mismatch for ${start}..${end}`
    );
  }
});

test("duplicate-dated observations still resolve to the last one in array order", () => {
  const cpi: Obs[] = [
    { date: "2020-01-01", value: 100 },
    { date: "2020-02-01", value: 110 },
    { date: "2020-02-01", value: 111 }, // duplicate date, later in array
    { date: "2020-03-01", value: 120 },
  ];
  assert.equal(
    cpiIndexRatioEndOverStart(cpi, "2020-01-01", "2020-02-01"),
    referenceRatio(cpi, "2020-01-01", "2020-02-01")
  );
  assert.equal(cpiIndexRatioEndOverStart(cpi, "2020-01-01", "2020-02-01"), 111 / 100);
});

test("an unsorted series falls back to scan semantics", () => {
  const cpi: Obs[] = [
    { date: "2020-03-01", value: 120 },
    { date: "2020-01-01", value: 100 },
    { date: "2020-02-01", value: 110 },
  ];
  assert.equal(
    cpiIndexRatioEndOverStart(cpi, "2020-02-01", "2020-03-01"),
    referenceRatio(cpi, "2020-02-01", "2020-03-01")
  );
});

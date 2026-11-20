import test from "node:test";
import assert from "node:assert/strict";

import {
  CPI_NSA_START_MONTH,
  CPI_SA_START_MONTH,
  composeCpiHistory,
  monthlyCpiFromInterpolatedDaily,
} from "../scripts/lib/cpi-history";

const near = (a: number | undefined, b: number, tol = 1e-9) => a !== undefined && Math.abs(a - b) <= tol;

// Upstream interpolates monthly CPI to days linearly, anchored on the 1st:
// v(day) = c_m + (c_{m+1} - c_m) * (day - 1) / daysInMonth.
function interpolated(month: string, cm: number, cnext: number, days: number[], daysInMonth: number) {
  return days.map((d) => ({ date: `${month}-${String(d).padStart(2, "0")}`, cpi: cm + ((cnext - cm) * (d - 1)) / daysInMonth }));
}

test("recovers each month's CPI from two interpolated rows, not the month-end value", () => {
  const rows = [
    ...interpolated("1890-01", 8.0, 8.31, [2, 3, 31], 31),
    ...interpolated("1890-02", 8.31, 8.1, [3, 28], 28),
  ];
  const byMonth = monthlyCpiFromInterpolatedDaily(rows);
  assert.ok(near(byMonth.get("1890-01"), 8.0));
  assert.ok(near(byMonth.get("1890-02"), 8.31));
  // The old reader took the last row: 1890-01 then held nearly February's value.
  assert.ok(!near(rows[2].cpi, 8.0, 0.01));
});

test("a month with fewer than two distinct days cannot be solved and is omitted", () => {
  const byMonth = monthlyCpiFromInterpolatedDaily([{ date: "1890-03-31", cpi: 8.2 }]);
  assert.equal(byMonth.has("1890-03"), false);
});

test("Shiller before 1913, CPIAUCNS 1913-1946, CPIAUCSL from 1947", () => {
  assert.equal(CPI_NSA_START_MONTH, "1913-01");
  assert.equal(CPI_SA_START_MONTH, "1947-01");
  const rows = composeCpiHistory({
    upstreamCpiByMonth: new Map([["1912-12", 9.7], ["1913-01", 99]]),
    nsaRows: [{ date: "1913-01-01", value: 9.8 }, { date: "1946-12-01", value: 19.5 }, { date: "1947-01-01", value: 99 }],
    saRows: [
      { date: "1946-12-01", value: 99 },
      { date: "1947-01-01", value: 21.48 },
      { date: "2025-10-01", value: 324.245, carriedForward: true },
    ],
  });
  assert.deepEqual(rows, [
    { date: "1912-12", value: 9.7, name: "CPI", source: "github-csv" },
    { date: "1913-01", value: 9.8, name: "CPIAUCNS", source: "fred" },
    { date: "1946-12", value: 19.5, name: "CPIAUCNS", source: "fred" },
    { date: "1947-01", value: 21.48, name: "CPIAUCSL", source: "fred" },
    { date: "2025-10", value: 324.245, name: "CPIAUCSL", source: "fred-carry-forward" },
  ]);
});

test("throws when FRED does not cover a segment's first month", () => {
  const base = { upstreamCpiByMonth: new Map([["1912-12", 9.7]]) };
  assert.throws(() => composeCpiHistory({ ...base, nsaRows: [], saRows: [{ date: "1947-01-01", value: 21.48 }] }), /CPIAUCNS/);
  assert.throws(() => composeCpiHistory({ ...base, nsaRows: [{ date: "1913-01-01", value: 9.8 }], saRows: [] }), /CPIAUCSL/);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  BORROW_RATE_SEGMENT_NAMES,
  FED_FUNDS_START_DATE,
  LIBOR_START_DATE,
  SOFR_START_DATE,
  composeBorrowRateHistory,
} from "../scripts/lib/borrow-rate-history";

const upstreamRows = [
  { date: "1954-06-29", swapRatePct: 2.52 },
  { date: "1954-06-30", swapRatePct: 2.52 },
  { date: "1954-07-01", swapRatePct: 0 },
  { date: "1985-12-31", swapRatePct: 7.56 },
  { date: "1986-01-02", swapRatePct: 8.125 },
  { date: "2018-04-02", swapRatePct: 1.88 },
  // Upstream keeps LIBOR after our SOFR switch; those rows must be ignored.
  { date: "2018-04-03", swapRatePct: 1.9 },
];

const inputs = {
  upstreamRows,
  commercialPaperPctByMonth: new Map([["1954-06", 1.58]]),
  fedFundsPctByDate: new Map([
    ["1954-07-01", 1.13],
    ["1985-12-31", 9.06],
  ]),
  sofrRows: [
    { date: "2018-04-03", valuePct: 1.83 },
    { date: "2018-04-04", valuePct: 1.74 },
  ],
};

test("segment boundaries are the documented source switch dates", () => {
  assert.equal(FED_FUNDS_START_DATE, "1954-07-01");
  assert.equal(LIBOR_START_DATE, "1986-01-02");
  assert.equal(SOFR_START_DATE, "2018-04-03");
});

test("each era takes its own source; upstream only supplies the date grid and LIBOR", () => {
  const rows = composeBorrowRateHistory(inputs);
  const byDate = new Map(rows.map((r) => [r.date, r]));

  // Commercial paper is monthly: every trading day of the month gets that month's rate,
  // never the upstream's quantized 2.52%.
  assert.deepEqual(byDate.get("1954-06-29"), {
    date: "1954-06-29", value: 0.0158, name: BORROW_RATE_SEGMENT_NAMES.commercialPaper, source: "fred",
  });
  assert.equal(byDate.get("1954-06-30")?.value, 0.0158);
  // Fed funds from its first print, regardless of the upstream value (0 here).
  assert.deepEqual(byDate.get("1954-07-01"), {
    date: "1954-07-01", value: 0.0113, name: BORROW_RATE_SEGMENT_NAMES.fedFunds, source: "fred",
  });
  assert.equal(byDate.get("1985-12-31")?.value, 0.0906);
  assert.deepEqual(byDate.get("1986-01-02"), {
    date: "1986-01-02", value: 0.08125, name: BORROW_RATE_SEGMENT_NAMES.libor, source: "github-csv",
  });
  assert.equal(byDate.get("2018-04-02")?.name, BORROW_RATE_SEGMENT_NAMES.libor);
  assert.deepEqual(byDate.get("2018-04-03"), {
    date: "2018-04-03", value: 0.0183, name: BORROW_RATE_SEGMENT_NAMES.sofr, source: "fred",
  });
  assert.deepEqual(rows.map((r) => r.date), [...rows.map((r) => r.date)].sort());
  assert.equal(rows.length, 8);
});

test("a missing commercial-paper month or fed-funds day is an error, not a silent gap", () => {
  assert.throws(
    () => composeBorrowRateHistory({ ...inputs, commercialPaperPctByMonth: new Map() }),
    /commercial paper.*1954-06/i
  );
  assert.throws(
    () => composeBorrowRateHistory({ ...inputs, fedFundsPctByDate: new Map([["1954-07-01", 1.13]]) }),
    /fed funds.*1985-12-31/i
  );
});

test("a non-finite or non-positive LIBOR row is skipped; a missing LIBOR era is an error", () => {
  const withBadLibor = composeBorrowRateHistory({
    ...inputs,
    upstreamRows: [...upstreamRows, { date: "1999-01-04", swapRatePct: Number.NaN }, { date: "1999-01-05", swapRatePct: 0 }],
  });
  assert.equal(withBadLibor.some((r) => r.date.startsWith("1999-01-0")), false);

  assert.throws(
    () => composeBorrowRateHistory({ ...inputs, upstreamRows: upstreamRows.filter((r) => r.date < LIBOR_START_DATE) }),
    /LIBOR/
  );
});

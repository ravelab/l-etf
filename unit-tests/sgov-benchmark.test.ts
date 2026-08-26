import test from "node:test";
import assert from "node:assert/strict";
import { buildSgovFinalValuesByWindow } from "../src/lib/sgov-benchmark";

test("buildSgovFinalValuesByWindow scales the initial investment by the price ratio", () => {
  const byWindow = buildSgovFinalValuesByWindow(
    [{ startDate: "2020-01-10", endDate: "2020-01-20" }],
    [
      { date: "2020-01-05", adj_close: 100, close: 100 },
      { date: "2020-01-15", adj_close: 110, close: 110 },
      { date: "2020-01-25", adj_close: 120, close: 120 },
    ],
    10_000,
  );
  assert.equal(byWindow.get("2020-01-10|2020-01-20"), 10_000 * (110 / 100));
});

test("buildSgovFinalValuesByWindow uses the last price on or before each bound", () => {
  const byWindow = buildSgovFinalValuesByWindow(
    [{ startDate: "2020-01-12", endDate: "2020-01-22" }],
    [
      { date: "2020-01-10", adj_close: 50, close: 50 },
      { date: "2020-01-20", adj_close: 75, close: 75 },
    ],
    1_000,
  );
  assert.equal(byWindow.get("2020-01-12|2020-01-22"), 1_000 * (75 / 50));
});

test("buildSgovFinalValuesByWindow skips windows with no usable prices", () => {
  const byWindow = buildSgovFinalValuesByWindow(
    [
      { startDate: "2019-01-01", endDate: "2019-06-01" },
      { startDate: "2020-01-01", endDate: "2020-06-01" },
    ],
    [{ date: "2020-03-01", adj_close: 100, close: 100 }],
    1_000,
  );
  assert.equal(byWindow.size, 0);
});

test("buildSgovFinalValuesByWindow skips non-positive prices", () => {
  const byWindow = buildSgovFinalValuesByWindow(
    [{ startDate: "2020-01-10", endDate: "2020-01-20" }],
    [
      { date: "2020-01-05", adj_close: 0, close: 0 },
      { date: "2020-01-15", adj_close: 110, close: 110 },
    ],
    1_000,
  );
  assert.equal(byWindow.size, 0);
});

test("buildSgovFinalValuesByWindow accepts unsorted input points", () => {
  const byWindow = buildSgovFinalValuesByWindow(
    [{ startDate: "2020-01-10", endDate: "2020-01-20" }],
    [
      { date: "2020-01-25", adj_close: 120, close: 120 },
      { date: "2020-01-05", adj_close: 100, close: 100 },
      { date: "2020-01-15", adj_close: 110, close: 110 },
    ],
    2_000,
  );
  assert.equal(byWindow.get("2020-01-10|2020-01-20"), 2_000 * (110 / 100));
});

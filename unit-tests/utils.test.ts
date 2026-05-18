import test from "node:test";
import assert from "node:assert/strict";
import {
  intersectCommonDates,
  formatDateSpan,
  validateSimulationReadyPrices,
  alignCloseSeriesToDates,
  parseNumberOrKeep,
  parsePositiveIntegerOrFallback,
} from "@/lib/utils";
import type { PricePoint } from "@/lib/simulation/types";

// --- parseNumberOrKeep ---

test("parseNumberOrKeep returns parsed number for valid input", () => {
  assert.equal(parseNumberOrKeep("3.14", 0), 3.14);
  assert.equal(parseNumberOrKeep("100", 0), 100);
  assert.equal(parseNumberOrKeep("-5", 0), -5);
});

test("parseNumberOrKeep returns current for empty string or non-number", () => {
  assert.equal(parseNumberOrKeep("", 42), 42);
  assert.equal(parseNumberOrKeep("  ", 42), 42);
  assert.equal(parseNumberOrKeep("abc", 42), 42);
  assert.equal(parseNumberOrKeep("NaN", 42), 42);
});

// --- parsePositiveIntegerOrFallback ---

test("parsePositiveIntegerOrFallback rounds to nearest int and enforces min 1", () => {
  assert.equal(parsePositiveIntegerOrFallback("5", 1), 5);
  assert.equal(parsePositiveIntegerOrFallback("2.7", 1), 3);
  assert.equal(parsePositiveIntegerOrFallback("0", 1), 1);
  assert.equal(parsePositiveIntegerOrFallback("-3", 1), 1);
});

test("parsePositiveIntegerOrFallback returns fallback for non-numeric input", () => {
  assert.equal(parsePositiveIntegerOrFallback("bad", 10), 10);
  // empty string coerces to 0, which becomes min 1 (not the fallback)
  assert.equal(parsePositiveIntegerOrFallback("", 10), 1);
});

// --- intersectCommonDates ---

test("intersectCommonDates returns sorted dates present in all lists", () => {
  const result = intersectCommonDates([
    ["2020-01-01", "2020-01-02", "2020-01-03"],
    ["2020-01-02", "2020-01-03", "2020-01-04"],
  ]);
  assert.deepEqual(result, ["2020-01-02", "2020-01-03"]);
});

test("intersectCommonDates returns empty for disjoint lists", () => {
  assert.deepEqual(
    intersectCommonDates([["2020-01-01"], ["2020-01-02"]]),
    [],
  );
});

test("intersectCommonDates returns empty for empty input", () => {
  assert.deepEqual(intersectCommonDates([]), []);
});

test("intersectCommonDates returns all dates for a single list", () => {
  assert.deepEqual(
    intersectCommonDates([["2020-01-03", "2020-01-01"]]),
    ["2020-01-01", "2020-01-03"],
  );
});

// --- formatDateSpan ---

test("formatDateSpan formats YYYY/MM – YYYY/MM from full date strings", () => {
  assert.equal(
    formatDateSpan({ start: "2020-01-15", end: "2021-06-30" }),
    "2020/01 – 2021/06",
  );
});

test("formatDateSpan returns empty string when no dates provided", () => {
  assert.equal(formatDateSpan(undefined), "");
});

// --- validateSimulationReadyPrices ---

function makeRow(date: string, adj_close: number | undefined): PricePoint {
  return { date, adj_close: adj_close as number, close: adj_close ?? 0 };
}

test("validateSimulationReadyPrices filters rows after endDate", () => {
  const rows = [makeRow("2020-01-01", 100), makeRow("2020-06-01", 110), makeRow("2021-01-01", 120)];
  const result = validateSimulationReadyPrices("spy", rows, "2020-12-31");
  assert.deepEqual(
    result.map((r) => r.date),
    ["2020-01-01", "2020-06-01"],
  );
});

test("validateSimulationReadyPrices removes rows with non-finite or zero adj_close", () => {
  const rows = [
    makeRow("2020-01-01", 100),
    makeRow("2020-01-02", 0),
    makeRow("2020-01-03", NaN),
    makeRow("2020-01-04", -10),
    makeRow("2020-01-05", 105),
  ];
  const result = validateSimulationReadyPrices("spy", rows, "2025-01-01");
  assert.deepEqual(
    result.map((r) => r.date),
    ["2020-01-01", "2020-01-05"],
  );
});

// --- alignCloseSeriesToDates ---

function makePrice(date: string, adj_close: number): PricePoint {
  return { date, adj_close, close: adj_close };
}

test("alignCloseSeriesToDates forward-fills missing daily prices", () => {
  const base: PricePoint[] = [
    makePrice("2020-01-01", 100),
    makePrice("2020-01-02", 100),
    makePrice("2020-01-03", 100),
    makePrice("2020-01-04", 100),
  ];
  const points: PricePoint[] = [
    makePrice("2020-01-01", 100),
    makePrice("2020-01-03", 102),
  ];
  const result = alignCloseSeriesToDates(base, points);
  assert.deepEqual(result, [100, 100, 102, 102]);
});

test("alignCloseSeriesToDates returns empty array for empty points", () => {
  const base: PricePoint[] = [makePrice("2020-01-01", 100)];
  assert.deepEqual(alignCloseSeriesToDates(base, []), []);
});

test("alignCloseSeriesToDates uses first known price before series starts", () => {
  const base: PricePoint[] = [
    makePrice("2019-12-30", 0),
    makePrice("2020-01-01", 0),
    makePrice("2020-01-02", 0),
  ];
  const points: PricePoint[] = [makePrice("2020-01-01", 200)];
  const result = alignCloseSeriesToDates(base, points);
  // dates before first known point use first point's price
  assert.equal(result[0], 200);
  assert.equal(result[1], 200);
  assert.equal(result[2], 200);
});

test("alignCloseSeriesToDates interpolates monthly data", () => {
  const basePrices = [
    { date: "2020-01-01", adj_close: 0, close: 100, source: "b", name: "b" },
    { date: "2020-01-16", adj_close: 0, close: 101, source: "b", name: "b" },
    { date: "2020-02-01", adj_close: 0, close: 102, source: "b", name: "b" },
  ];
  const points = [
    { date: "2020-01", adj_close: 100, close: 100, source: "p", name: "p" },
    { date: "2020-02", adj_close: 121, close: 121, source: "p", name: "p" },
  ];
  
  const aligned = alignCloseSeriesToDates(basePrices, points);
  assert.equal(aligned[0], 100);
  // Geometric interpolation for midpoint (15 days elapsed out of ~31)
  // 100 * (121/100)^(15/31) ~= 110
  assert.equal(Math.round(aligned[1]), 110);
  assert.equal(aligned[2], 121);
});

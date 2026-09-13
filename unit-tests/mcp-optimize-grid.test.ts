import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAxis,
  findNeighbours,
  planOptimizationGrid,
  splitRangeInHalf,
} from "@/lib/mcp/optimize-grid";
import { McpToolError } from "@/lib/mcp/tool-result";

test("buildAxis walks min..max inclusive on the step", () => {
  assert.deepEqual(buildAxis(100, 200, 25), [100, 125, 150, 175, 200]);
  assert.deepEqual(buildAxis(1, 4, 1), [1, 2, 3, 4]);
});

test("buildAxis includes the endpoint only when the step lands on it", () => {
  assert.deepEqual(buildAxis(100, 210, 25), [100, 125, 150, 175, 200]);
});

test("buildAxis collapses a zero-width range to a single value", () => {
  assert.deepEqual(buildAxis(150, 150, 25), [150]);
});

test("buildAxis rounds away floating-point dust", () => {
  // 0.1 steps otherwise produce 1.7999999999999998.
  assert.deepEqual(buildAxis(1.5, 1.8, 0.1), [1.5, 1.6, 1.7, 1.8]);
});

test("buildAxis rejects a non-positive step rather than looping forever", () => {
  assert.throws(() => buildAxis(1, 4, 0), McpToolError);
  assert.throws(() => buildAxis(1, 4, -1), McpToolError);
});

test("buildAxis rejects an inverted range", () => {
  assert.throws(() => buildAxis(4, 1, 1), McpToolError);
});

test("planOptimizationGrid is the full cross product, with stable ids", () => {
  const cells = planOptimizationGrid({ periods: [100, 200], uppers: [1, 2], lowers: [3] });
  assert.equal(cells.length, 4);
  assert.deepEqual(
    cells.map((c) => [c.smaPeriod, c.upperBuffer, c.lowerBuffer]),
    [
      [100, 1, 3],
      [100, 2, 3],
      [200, 1, 3],
      [200, 2, 3],
    ],
  );
  assert.equal(new Set(cells.map((c) => c.id)).size, 4, "ids are unique");
  // Ids must survive a round trip through the engine, which only carries strings.
  for (const cell of cells) assert.match(cell.id, /^opt-/);
});

test("planOptimizationGrid refuses an empty grid", () => {
  assert.throws(() => planOptimizationGrid({ periods: [], uppers: [1], lowers: [1] }), McpToolError);
});

test("findNeighbours returns the cells one step away on each axis", () => {
  const cells = planOptimizationGrid({
    periods: [100, 150, 200],
    uppers: [1, 2, 3],
    lowers: [1, 2, 3],
  });
  const centre = cells.find((c) => c.smaPeriod === 150 && c.upperBuffer === 2 && c.lowerBuffer === 2)!;
  const neighbours = findNeighbours(centre, cells);
  // One step either way on three axes, and nothing diagonal.
  assert.equal(neighbours.length, 6);
  for (const n of neighbours) {
    const axesChanged =
      Number(n.smaPeriod !== centre.smaPeriod) +
      Number(n.upperBuffer !== centre.upperBuffer) +
      Number(n.lowerBuffer !== centre.lowerBuffer);
    assert.equal(axesChanged, 1, "neighbours differ on exactly one axis");
  }
});

test("findNeighbours on a corner returns only the cells that exist", () => {
  const cells = planOptimizationGrid({ periods: [100, 150], uppers: [1, 2], lowers: [1, 2] });
  const corner = cells.find((c) => c.smaPeriod === 100 && c.upperBuffer === 1 && c.lowerBuffer === 1)!;
  assert.equal(findNeighbours(corner, cells).length, 3);
});

test("findNeighbours on a single-cell grid returns nothing", () => {
  const cells = planOptimizationGrid({ periods: [150], uppers: [2], lowers: [2] });
  assert.deepEqual(findNeighbours(cells[0], cells), []);
});

test("splitRangeInHalf splits on the calendar midpoint", () => {
  const { inSample, outOfSample } = splitRangeInHalf("2000-01-01", "2020-01-01");
  assert.equal(inSample.startDate, "2000-01-01");
  assert.equal(outOfSample.endDate, "2020-01-01");
  assert.equal(inSample.endDate, outOfSample.startDate, "the halves meet, with no gap");
  assert.ok(inSample.endDate > "2009-01-01" && inSample.endDate < "2011-01-01", inSample.endDate);
});

test("splitRangeInHalf refuses a range too short to halve meaningfully", () => {
  assert.throws(() => splitRangeInHalf("2020-01-01", "2020-02-01"), McpToolError);
});

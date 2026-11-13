import test from "node:test";
import assert from "node:assert/strict";
import { spaceChartLabels } from "@/lib/chart-label-layout";

test("preserves uncrowded labels at their percentile ticks", () => {
  assert.deepEqual(spaceChartLabels([90, 50, 10], 0, 100, 14), [90, 50, 10]);
});

test("keeps all five coincident percentile labels, with balanced spacing", () => {
  assert.deepEqual(spaceChartLabels([50, 50, 50, 50, 50], 0, 100, 14), [22, 36, 50, 64, 78]);
});

test("crowded edge labels remain ordered, separated, and inside the plot", () => {
  for (const anchors of [[0, 1, 2, 3, 4], [96, 97, 98, 99, 100], [2, 3, 50, 98, 99]]) {
    const result = spaceChartLabels(anchors, 6, 94, 14);
    assert.equal(result.length, anchors.length);
    assert.ok(result[0] >= 6);
    assert.ok(result.at(-1)! <= 94);
    for (let i = 1; i < result.length; i++) assert.ok(result[i] - result[i - 1] >= 14);
  }
});

test("empty and tiny plots do not silently drop labels", () => {
  assert.deepEqual(spaceChartLabels([], 0, 10, 14), []);
  assert.deepEqual(spaceChartLabels([50], 0, 10, 14), [10]);
  assert.deepEqual(spaceChartLabels([5, 5, 5, 5, 5], 0, 20, 14), [0, 5, 10, 15, 20]);
});

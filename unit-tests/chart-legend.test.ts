import assert from "node:assert/strict";
import test from "node:test";
import { linkedLegendDatasetIndices } from "@/lib/chart-legend";

const datasets = [
  { seriesKey: "upro" }, // raincloud
  { seriesKey: "tqqq" }, // raincloud
  { seriesKey: "upro" }, // median line
  { seriesKey: "tqqq" }, // median line
  { seriesKey: "upro" }, // n/total line
  { seriesKey: "tqqq" }, // n/total line
];

test("a legend click toggles every dataset in the same series", () => {
  assert.deepEqual(linkedLegendDatasetIndices(datasets, 1), [1, 3, 5]);
  assert.deepEqual(linkedLegendDatasetIndices(datasets, 0), [0, 2, 4]);
});

test("datasets without a series key toggle alone", () => {
  assert.deepEqual(linkedLegendDatasetIndices([{ seriesKey: "upro" }, {}], 1), [1]);
});

test("an out-of-range index toggles nothing", () => {
  assert.deepEqual(linkedLegendDatasetIndices(datasets, -1), []);
  assert.deepEqual(linkedLegendDatasetIndices(datasets, datasets.length), []);
});

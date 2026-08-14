import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLogRaincloudDensity,
  sampleRaincloudItems,
  sampleRaincloudValues,
} from "@/lib/raincloud";

test("buildLogRaincloudDensity returns an ordered normalized profile", () => {
  const profile = buildLogRaincloudDensity(
    [0.72, 0.84, 0.92, 0.98, 1, 1.02, 1.08, 1.21, 1.46],
    0.8,
    1.3,
    24,
  );

  assert.equal(profile.length, 24);
  assert.ok(profile.every((point) => point.value > 0));
  assert.ok(profile.every((point) => point.density >= 0 && point.density <= 1));
  assert.equal(Math.max(...profile.map((point) => point.density)), 1);
  assert.ok(profile.every((point, index) => index === 0 || point.value > profile[index - 1].value));
});

test("buildLogRaincloudDensity uses the supplied visible whisker range", () => {
  const profile = buildLogRaincloudDensity([0.5, 1, 2], 0.75, 1.5, 12);

  assert.ok(Math.abs(profile[0].value - 0.75) < 1e-10);
  assert.ok(Math.abs(profile.at(-1)!.value - 1.5) < 1e-10);
});

test("sampleRaincloudValues is deterministic, capped, and preserves tails", () => {
  const values = Array.from({ length: 101 }, (_, index) => (index + 1) / 10);
  const sample = sampleRaincloudValues(values, 15);

  assert.equal(sample.length, 15);
  assert.equal(sample[0], 0.1);
  assert.equal(sample.at(-1), 10.1);
  assert.deepEqual(sample, sampleRaincloudValues([...values].reverse(), 15));
});

test("sampleRaincloudItems preserves metadata for each sampled value", () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    date: `day-${index + 1}`,
    value: (index + 1) / 10,
  }));
  const sample = sampleRaincloudItems(items, (item) => item.value, 3);

  assert.deepEqual(sample, [items[0], items[50], items[100]]);
});

test("raincloud helpers discard invalid return factors", () => {
  assert.deepEqual(sampleRaincloudValues([Number.NaN, -1, 0, 1.2, Infinity]), [1.2]);
  assert.deepEqual(buildLogRaincloudDensity([Number.NaN, -1, 0], 0.8, 1.2), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  FORWARD_GAP_BIN_MAX_PCT,
  FORWARD_GAP_BIN_MIN_PCT,
  FORWARD_GAP_BIN_WIDTH_PCT,
  binIndexForGap,
  binLabelForIndex,
  bucketizeForwardPoints,
  summarizeForwardBins,
} from "@/lib/forward-sma-bins";
import type { ForwardSmaReturnPoint } from "@/lib/simulation/forward-sma-returns";

const point = (gap: number, realReturnFactor: number): ForwardSmaReturnPoint => ({
  date: "2000-01-03",
  gap,
  realReturnFactor,
});

test("binIndexForGap places a gap in the bin covering it", () => {
  assert.equal(binIndexForGap(FORWARD_GAP_BIN_MIN_PCT), 0);
  assert.equal(binIndexForGap(FORWARD_GAP_BIN_MIN_PCT + FORWARD_GAP_BIN_WIDTH_PCT), 1);
  assert.equal(binIndexForGap(0), Math.floor(-FORWARD_GAP_BIN_MIN_PCT / FORWARD_GAP_BIN_WIDTH_PCT));
});

test("gaps past the edges fold into the edge bins rather than falling out", () => {
  const binCount = Math.round(
    (FORWARD_GAP_BIN_MAX_PCT - FORWARD_GAP_BIN_MIN_PCT) / FORWARD_GAP_BIN_WIDTH_PCT,
  );
  assert.equal(binIndexForGap(-999), 0);
  assert.equal(binIndexForGap(999), binCount - 1);
  assert.equal(binIndexForGap(FORWARD_GAP_BIN_MAX_PCT), binCount - 1);
});

test("edge bin labels read as open-ended, inner ones as a range", () => {
  const binCount = Math.round(
    (FORWARD_GAP_BIN_MAX_PCT - FORWARD_GAP_BIN_MIN_PCT) / FORWARD_GAP_BIN_WIDTH_PCT,
  );
  assert.match(binLabelForIndex(0), /^≤/);
  assert.match(binLabelForIndex(binCount - 1), /^≥/);
  assert.match(binLabelForIndex(1), /to/);
});

test("bucketize drops non-positive return factors, which cannot be real", () => {
  const buckets = bucketizeForwardPoints([
    point(0, 1.1),
    point(0, 0),
    point(0, -1),
    point(0, Number.NaN),
  ]);
  const zeroBin = buckets[binIndexForGap(0)];
  assert.equal(zeroBin.length, 1);
  assert.equal(zeroBin[0].realReturnFactor, 1.1);
});

test("summarizeForwardBins reports only bins that hold points", () => {
  const summary = summarizeForwardBins([
    point(-15, 1.2),
    point(-15, 1.4),
    point(10, 0.9),
  ]);
  assert.equal(summary.length, 2, "empty bins are omitted");
  for (const bin of summary) {
    assert.ok(bin.count > 0);
    assert.ok(bin.label.length > 0);
    assert.ok(Number.isFinite(bin.medianRealReturnPct));
  }
});

test("summarizeForwardBins reports returns as percentages, not factors", () => {
  const [bin] = summarizeForwardBins([point(0, 1.25), point(0, 1.25), point(0, 1.25)]);
  assert.ok(Math.abs(bin.medianRealReturnPct - 25) < 1e-9, `${bin.medianRealReturnPct}`);
  assert.equal(bin.count, 3);
});

test("summarizeForwardBins orders bins from the most negative gap upward", () => {
  const summary = summarizeForwardBins([point(12, 1.1), point(-18, 1.2), point(0, 1.0)]);
  const lows = summary.map((b) => b.fromGapPct);
  assert.deepEqual(lows, [...lows].sort((a, b) => a - b));
});

test("summarizeForwardBins carries a percentile spread, not just a median", () => {
  const points = Array.from({ length: 21 }, (_, i) => point(0, 1 + i / 100));
  const [bin] = summarizeForwardBins(points);
  assert.ok(bin.p10RealReturnPct < bin.medianRealReturnPct);
  assert.ok(bin.p90RealReturnPct > bin.medianRealReturnPct);
  assert.equal(bin.count, 21);
});

test("summarizeForwardBins on no points returns nothing", () => {
  assert.deepEqual(summarizeForwardBins([]), []);
});

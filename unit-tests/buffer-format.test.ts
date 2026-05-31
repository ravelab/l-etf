import test from "node:test";
import assert from "node:assert/strict";
import {
  formatBufferPercent,
  formatLowerBuffer,
  formatSmaSummary,
} from "@/lib/buffer-format";

test("formatBufferPercent trims trailing zeros and caps fractional digits", () => {
  assert.equal(formatBufferPercent(3), "3%");
  assert.equal(formatBufferPercent(3.3), "3.3%");
  assert.equal(formatBufferPercent(3.0), "3%");
  assert.equal(formatBufferPercent(12.5), "12.5%");
  assert.equal(formatBufferPercent(3.333), "3.33%");
  assert.equal(formatBufferPercent(0), "0%");
});

test("formatBufferPercent guards against non-finite input", () => {
  assert.equal(formatBufferPercent(Number.NaN), "0%");
  assert.equal(formatBufferPercent(Number.POSITIVE_INFINITY), "0%");
});

test("formatLowerBuffer prefixes a minus sign", () => {
  assert.equal(formatLowerBuffer(3.3), "−3.3%");
  assert.equal(formatLowerBuffer(4), "−4%");
});

test("formatSmaSummary renders index, period, and both buffers", () => {
  assert.equal(formatSmaSummary("SPX", 186, 3.3, 3), "SPX: 186/−3.3%/3%");
  assert.equal(formatSmaSummary("NDX", 70, 12, 12), "NDX: 70/−12%/12%");
});

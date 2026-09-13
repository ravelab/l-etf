import test from "node:test";
import assert from "node:assert/strict";
import { computeSma, generateSmaSignals } from "@/lib/simulation/sma";
import { SMA_CACHE_MAX_ENTRIES } from "@/lib/simulation/bounded-cache";

function series(n: number): number[] {
  // Deterministic, non-monotonic: enough shape to produce real crossovers.
  return Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 9) * 20 + i * 0.05);
}

function dates(n: number): string[] {
  const out: string[] = [];
  const start = Date.UTC(1990, 0, 1);
  for (let i = 0; i < n; i += 1) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

test("computeSma is correct after the cache has evicted its entry", () => {
  const prices = series(400);
  const first = computeSma(prices, 20);
  // Push well past the cap on the SAME prices array, so period 20 is evicted.
  for (let p = 30; p < 30 + SMA_CACHE_MAX_ENTRIES * 2; p += 1) computeSma(prices, p);
  const recomputed = computeSma(prices, 20);
  assert.deepEqual(recomputed, first, "a recomputed SMA must equal the evicted one");
});

test("computeSma still returns the cached array on a hit", () => {
  const prices = series(300);
  assert.equal(computeSma(prices, 50), computeSma(prices, 50), "same reference on a hit");
});

test("computeSma matches a naive mean, with NaN before the window fills", () => {
  const prices = series(60);
  const period = 10;
  const sma = computeSma(prices, period);
  for (let i = 0; i < period - 1; i += 1) assert.ok(Number.isNaN(sma[i]));
  for (let i = period - 1; i < prices.length; i += 1) {
    const naive = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    assert.ok(Math.abs(sma[i] - naive) < 1e-9, `index ${i}: ${sma[i]} vs ${naive}`);
  }
});

test("generateSmaSignals is correct after its cache has evicted the entry", () => {
  const n = 500;
  const prices = series(n);
  const d = dates(n);
  const buffer = { upper: 2, lower: 3 };
  const first = generateSmaSignals(d, prices, 20, buffer);
  assert.ok(first.signals.length > 0, "the fixture must actually produce crossovers");

  for (let p = 30; p < 30 + SMA_CACHE_MAX_ENTRIES * 2; p += 1) {
    generateSmaSignals(d, prices, p, buffer);
  }
  const recomputed = generateSmaSignals(d, prices, 20, buffer);
  assert.deepEqual(recomputed.signals, first.signals);
  assert.deepEqual(recomputed.invested, first.invested);
  assert.deepEqual(recomputed.smaValues, first.smaValues);
});

test("the SMA cache cap is large enough for a sweep chunk but bounded", () => {
  // Each entry retains a full-length series; an unbounded cache made a
  // 1,000-config sweep OOM at a 512 MB heap regardless of chunk size.
  assert.ok(SMA_CACHE_MAX_ENTRIES >= 48, "must cover a whole sweep chunk");
  assert.ok(SMA_CACHE_MAX_ENTRIES <= 512, "must stay bounded");
});

import type { PricePoint } from "./types";
import { CONSTANT_INITIAL_INVESTMENT } from "../constants";
import { adjustedOpenFromPricePoint } from "../utils";

/**
 * Pre-computed derived arrays from PricePoint[].
 * These are computed ONCE per unique price array and reused across all simulations.
 */
export interface DerivedArrays {
  dates: string[];
  indexValues: number[];
  openPrices: number[];
  closePrices: number[];
  indexReturns: number[];  // Pre-computed daily returns: (index[i] - index[i-1]) / index[i-1]
}

/**
 * Global cache for derived arrays.
 * Uses content-hash based caching to hit even when array references differ
 * (e.g., sliced windows from the same underlying data).
 */
const derivedArraysCache = new Map<string, DerivedArrays>();
const derivedArraysWeakCache = new WeakMap<PricePoint[], DerivedArrays>();
const DERIVED_ARRAYS_CACHE_MAX = 500;
const DERIVED_ARRAYS_CACHE_KEEP = 250;

/** FNV-1a step over one character code or byte. */
function fnvStep(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, 16777619);
}

function hashString(hash: number, value: string): number {
  let next = hash;
  for (let j = 0; j < value.length; j++) next = fnvStep(next, value.charCodeAt(j));
  return next;
}

function hashNumber(hash: number, value: number): number {
  const bytes = new Uint8Array(new Float64Array([value]).buffer);
  let next = hash;
  for (let j = 0; j < bytes.length; j++) next = fnvStep(next, bytes[j]);
  return next;
}

/**
 * Hash every field the cached payload is built from: the return-series close,
 * the SMA close, and both opens. Leaving one out lets two series that differ
 * only in that field share derived arrays.
 */
function hashPricePoint(hash: number, p: PricePoint): number {
  const withDate = hashString(hash, p.date);
  const withCloses = hashNumber(hashNumber(withDate, p.adj_close), p.close);
  return hashNumber(hashNumber(withCloses, p.open ?? Number.NaN), p.adj_open ?? Number.NaN);
}

/**
 * Compute a hash key for a PricePoint[] array for caching purposes.
 * Samples the array to avoid O(n) hash computation for large arrays.
 */
function hashPricePoints(prices: PricePoint[]): string {
  const len = prices.length;
  let hash = 2166136261;

  // Sample up to 500 points for hashing, always including the final row: with
  // step = floor(len/500) the last sampled index falls short of the end (for
  // len 35,000 it stops at 34,930), so two series differing only in a replaced
  // or synthetic tail would collide and silently share cached derived arrays.
  const step = Math.max(1, Math.floor(len / 500));
  for (let i = 0; i < len; i += step) hash = hashPricePoint(hash, prices[i]);

  // Fold in the final row explicitly; the sampling stride can skip it.
  if (len > 0) hash = hashPricePoint(hash, prices[len - 1]);
  return `${len}:${hash >>> 0}`;
}

/** Daily return of an adjusted-close series; a zero or non-finite neighbour yields 0, never NaN. */
function guardedDailyReturn(prev: number, curr: number): number {
  return prev !== 0 && isFinite(prev) && isFinite(curr)
    ? (curr - prev) / prev
    : 0;
}

function computeDerivedArrays(prices: PricePoint[]): DerivedArrays {
  const indexValues = prices.map((p) => p.adj_close);
  const indexReturns = new Array<number>(prices.length);
  indexReturns[0] = 0;
  for (let i = 1; i < prices.length; i++) {
    indexReturns[i] = guardedDailyReturn(indexValues[i - 1], indexValues[i]);
  }

  return {
    dates: prices.map((p) => p.date),
    indexValues,
    openPrices: prices.map(adjustedOpenFromPricePoint),
    closePrices: prices.map((p) => p.close),
    indexReturns,
  };
}

function rememberDerivedArrays(hashKey: string, prices: PricePoint[], result: DerivedArrays): void {
  derivedArraysCache.set(hashKey, result);
  derivedArraysWeakCache.set(prices, result);

  // Keep the content cache bounded: drop all but the most recent entries.
  if (derivedArraysCache.size > DERIVED_ARRAYS_CACHE_MAX) {
    const entries = Array.from(derivedArraysCache.entries());
    derivedArraysCache.clear();
    for (const [key, value] of entries.slice(-DERIVED_ARRAYS_CACHE_KEEP)) {
      derivedArraysCache.set(key, value);
    }
  }
}

/**
 * Extract and pre-compute all derived arrays from PricePoint[].
 * Results are cached globally to avoid redundant computation across
 * rolling windows and multiple simulations.
 */
export function extractDerivedArrays(prices: PricePoint[]): DerivedArrays {
  // Try WeakMap first (fastest, identity-based)
  const weakCached = derivedArraysWeakCache.get(prices);
  if (weakCached) return weakCached;

  // Try content-based cache
  const hashKey = hashPricePoints(prices);
  const cached = derivedArraysCache.get(hashKey);
  if (cached) {
    derivedArraysWeakCache.set(prices, cached);
    return cached;
  }

  const result = computeDerivedArrays(prices);
  rememberDerivedArrays(hashKey, prices, result);
  return result;
}

const nonLeveragedCache = new WeakMap<number[], number[]>();

/**
 * The 1x, fee-free path of an index from CONSTANT_INITIAL_INVESTMENT.
 * Uses the same guard as `indexReturns`: one adj_close of 0 or a NaN from a
 * splice seam would otherwise turn this value Infinity/NaN and poison every
 * later one, while the LETF series stays finite and the downstream NaN check
 * only inspects that series.
 */
export function computeNonLeveraged(indexValues: number[]): number[] {
  const cached = nonLeveragedCache.get(indexValues);
  if (cached) return cached;

  const values = new Array<number>(indexValues.length);
  values[0] = CONSTANT_INITIAL_INVESTMENT;
  for (let i = 1; i < indexValues.length; i++) {
    values[i] = values[i - 1] * (1 + guardedDailyReturn(indexValues[i - 1], indexValues[i]));
  }

  nonLeveragedCache.set(indexValues, values);
  return values;
}

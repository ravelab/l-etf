import test from "node:test";
import assert from "node:assert/strict";
import { boundedCacheGet, boundedCacheSet } from "@/lib/simulation/bounded-cache";

test("boundedCacheSet evicts the least recently used entry at the cap", () => {
  const cache = new Map<string, number>();
  boundedCacheSet(cache, "a", 1, 2);
  boundedCacheSet(cache, "b", 2, 2);
  boundedCacheSet(cache, "c", 3, 2);
  assert.equal(cache.size, 2);
  assert.equal(cache.has("a"), false, "oldest entry evicted");
  assert.deepEqual([...cache.keys()], ["b", "c"]);
});

test("boundedCacheGet refreshes recency so a hot entry survives eviction", () => {
  const cache = new Map<string, number>();
  boundedCacheSet(cache, "a", 1, 2);
  boundedCacheSet(cache, "b", 2, 2);
  assert.equal(boundedCacheGet(cache, "a"), 1, "a is still present");
  // "a" is now the most recent, so adding "c" must evict "b" instead.
  boundedCacheSet(cache, "c", 3, 2);
  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
});

test("boundedCacheGet returns undefined for a miss without inserting", () => {
  const cache = new Map<string, number>();
  assert.equal(boundedCacheGet(cache, "nope"), undefined);
  assert.equal(cache.size, 0);
});

test("re-setting an existing key updates it without growing the cache", () => {
  const cache = new Map<string, number>();
  boundedCacheSet(cache, "a", 1, 2);
  boundedCacheSet(cache, "a", 9, 2);
  assert.equal(cache.size, 1);
  assert.equal(boundedCacheGet(cache, "a"), 9);
});

test("a cap of 1 keeps only the newest entry", () => {
  const cache = new Map<string, number>();
  boundedCacheSet(cache, "a", 1, 1);
  boundedCacheSet(cache, "b", 2, 1);
  assert.deepEqual([...cache.keys()], ["b"]);
});

test("a non-positive cap stores nothing rather than looping or growing", () => {
  const cache = new Map<string, number>();
  boundedCacheSet(cache, "a", 1, 0);
  assert.equal(cache.size, 0);
});

test("the cache never grows past the cap over many distinct keys", () => {
  const cache = new Map<number, number>();
  for (let i = 0; i < 1000; i += 1) boundedCacheSet(cache, i, i, 16);
  assert.equal(cache.size, 16);
  assert.equal(boundedCacheGet(cache, 999), 999, "newest key retained");
  assert.equal(boundedCacheGet(cache, 0), undefined, "oldest key evicted");
});

// LRU bounds for the engine's per-parameter memo caches.
//
// `sma.ts` memoizes by (prices array identity, SMA parameters) through a
// WeakMap whose *values* are plain Maps. The WeakMap key is the price series,
// which stays alive for a whole sweep, so those inner Maps only ever grow —
// once per distinct parameter set, each retaining a full-length series. That is
// invisible at a handful of configs and fatal at a few hundred: a 1,000-config
// sweep ran out of memory at a 512 MB heap no matter how small the chunks were,
// because the leak is per *config*, not per chunk.
//
// These helpers mutate the cache Map by design — that is what a cache is. The
// values they hold are never mutated.

/**
 * Entries kept per price series, per cache. Each entry retains an array as long
 * as the price history (~35k doubles over full history, ~284 KB), so this is
 * the knob that trades hit rate for bounded memory. It only has to cover the
 * configs live in one engine call; reuse beyond that is incidental.
 */
export const SMA_CACHE_MAX_ENTRIES = 128;

/**
 * Read an entry and mark it most-recently-used. A `Map` iterates in insertion
 * order, so re-inserting on a hit is what makes eviction LRU rather than FIFO.
 */
export function boundedCacheGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key) as V;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * Insert an entry, evicting least-recently-used entries to stay within
 * `maxEntries`. A non-positive cap stores nothing.
 */
export function boundedCacheSet<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  maxEntries: number,
): void {
  if (maxEntries <= 0) return;
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

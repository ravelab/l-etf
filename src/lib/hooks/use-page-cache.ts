import { SHARED_KEYS } from "./use-shared-inputs";

/**
 * Module-level page state cache.
 * Persists across client-side navigations (next/link) within the same session.
 * Cleared on hard refresh.
 *
 * For persistence across hard refreshes / app relaunches, we save to
 * localStorage using per-page keys to avoid quota issues with large results.
 */
const caches = new Map<string, Record<string, unknown>>();

export const PAGE_CACHE_PREFIX = "pageCache:v3:";
const LS_PREFIX = PAGE_CACHE_PREFIX;

// Throws on quota exceeded so caller can fallback.
function savePersistentCache(pageKey: string, data: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_PREFIX + pageKey, JSON.stringify(data));
}

export function usePageCache<T extends Record<string, unknown>>(
  pageKey: string,
  defaults: T,
  options?: { persistKeys?: Array<keyof T> }
): { initial: T; save: (state: T) => void; restoredFromCache: boolean } {
  const persistKeys = options?.persistKeys ?? null;
  const persistKeySet = persistKeys ? new Set<string>(persistKeys.map((k) => String(k))) : null;

  const pickPersisted = (obj: Partial<T> | T): Partial<T> => {
    if (!persistKeySet) return obj;
    const out: Partial<T> = {};
    for (const k of persistKeys ?? []) {
      const keyStr = String(k);
      if (keyStr in obj) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (out as any)[k] = (obj as any)[k];
      }
    }
    return out;
  };

  const stripSharedInputKeys = (obj: Partial<T> | null): Partial<T> | null => {
    if (!obj) return null;
    const out = { ...obj } as Partial<T>;
    for (const key in out) {
      if (SHARED_KEYS.has(key)) {
        delete out[key];
      }
    }
    return out;
  };

  const cached = caches.get(pageKey) as T | undefined;
  // Do not read localStorage during render. Doing so causes hydration mismatches
  // when the client restores cached page state that was not present in the server HTML.
  // Hard-refresh restoration should happen through post-mount snapshot hydration instead.
  // In-memory cache is session-local and safe to restore in full so tab switches keep results.
  const initialFromCache = stripSharedInputKeys(cached ?? null);

  const initial = initialFromCache
    ? ({ ...defaults, ...initialFromCache } as T)
    : defaults;

  const restoredFromCache = !!initialFromCache;

  return {
    initial,
    restoredFromCache,
    save: (state: T) => {
      caches.set(pageKey, state);

      if (typeof window === "undefined") return;
      try {
        savePersistentCache(pageKey, state);
      } catch {
        // Quota exceeded — fall back to config-only keys (exclude large result arrays)
        // Results are still preserved in memory cache for current session
        try {
          const configOnly = pickPersisted(state) as Record<string, unknown>;
          // Explicitly exclude large arrays that cause quota issues
          delete configOnly.simulations;
          delete configOnly.variantRuns;
          delete configOnly.comboResultsBySubPresetName;
          delete configOnly.variantSummaries;
          delete configOnly.yearlyGrowthSeries;
          savePersistentCache(pageKey, configOnly);
        } catch {
          // ignore
        }
        console.warn('Page cache: localStorage quota exceeded, saving config only. Results preserved in memory for this session.');
      }
    },
  };
}

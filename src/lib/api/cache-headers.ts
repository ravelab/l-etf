type DataCacheSource = "memory" | "runtime" | "file" | "fallback";

type CacheHeaderOptions = {
  maxAgeSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  dataCacheSources?: DataCacheSource[];
};

const DEFAULT_MAX_AGE_SECONDS = 60 * 60;
const DEFAULT_STALE_WHILE_REVALIDATE_SECONDS = 60 * 60 * 24;

export function buildApiCacheHeaders(options: CacheHeaderOptions = {}): HeadersInit {
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const staleWhileRevalidate =
    options.staleWhileRevalidateSeconds ?? DEFAULT_STALE_WHILE_REVALIDATE_SECONDS;
  const cdnCacheControl = `public, s-maxage=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`;
  const dataCacheSources = options.dataCacheSources ?? [];
  const dataCache = dataCacheSources.length > 0 ? dataCacheSources.join(",") : "none";

  return {
    "Cache-Control": "public, max-age=0, must-revalidate",
    "CDN-Cache-Control": cdnCacheControl,
    "Vercel-CDN-Cache-Control": cdnCacheControl,
    "Server-Timing": `csv-cache;desc="${dataCache}"`,
    "X-Data-Cache": dataCache,
  };
}

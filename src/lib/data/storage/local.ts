import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getCache } from "@vercel/functions";
import { IStorage, DailyPrice } from "./types";

const DATA_DIR = join(process.cwd(), "data");
const RUNTIME_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;
const RUNTIME_CACHE_CHUNK_TARGET_BYTES = 1_500_000;
const RUNTIME_CACHE_TAGS = ["csv-data"];

// Bump when the parsed row schema changes — invalidates all prior cache entries.
// v2: include size in the key. Vercel deploy mtimes can collide across different
// CSV contents, which previously let a stale runtime-cache entry shadow a newer
// traced data/*.csv (SPX stuck at 2026-07-06 while NDX advanced).
const RUNTIME_CACHE_SCHEMA_VERSION = "v2";

const runtimeCache = getCache({ namespace: "csv-data" });

// Skip writes outside of request-serving function contexts. The runtime cache is
// per-region and only useful for sharing data across function invocations in the
// same region — populating it from a build container, a script, or a one-shot
// process just burns the free-tier write budget.
function shouldWriteRuntimeCache(): boolean {
  if (process.env.DISABLE_RUNTIME_CACHE_WRITES === "1") return false;
  return true;
}

type CsvCacheManifest = {
  mtime: number;
  size: number;
  chunkCount: number;
};

type CsvCacheSource = "memory" | "runtime" | "file" | "fallback";

type CsvCacheDiagnostic = {
  file: string;
  source: CsvCacheSource;
};

const csvCacheDiagnostics = new AsyncLocalStorage<CsvCacheDiagnostic[]>();

/**
 * In-memory cache to avoid reading and parsing the same CSV multiple times.
 * Stores both the parsed data and the modification time (mtime) of the file
 * when it was last read.
 */
const csvCache = new Map<string, { data: unknown[]; mtime: number }>();

function recordCsvCacheSource(filePath: string, source: CsvCacheSource) {
  const diagnostics = csvCacheDiagnostics.getStore();
  if (!diagnostics) return;
  diagnostics.push({
    file: relative(DATA_DIR, filePath).replaceAll("\\", "/"),
    source,
  });
}

export async function withCsvCacheDiagnostics<T>(
  callback: () => Promise<T>,
): Promise<{ value: T; sources: CsvCacheSource[] }> {
  const diagnostics: CsvCacheDiagnostic[] = [];
  const value = await csvCacheDiagnostics.run(diagnostics, callback);
  return {
    value,
    sources: [...new Set(diagnostics.map((entry) => entry.source))],
  };
}

function isCsvCacheManifest(value: unknown): value is CsvCacheManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CsvCacheManifest).mtime === "number" &&
    typeof (value as CsvCacheManifest).size === "number" &&
    typeof (value as CsvCacheManifest).chunkCount === "number"
  );
}

function getRuntimeCacheKeys(filePath: string, mtime: number, size: number) {
  const fileKey = relative(DATA_DIR, filePath).replaceAll("\\", "/");
  const baseKey = `${RUNTIME_CACHE_SCHEMA_VERSION}:mtime-${mtime}:size-${size}:${fileKey}`;
  return {
    manifestKey: `${baseKey}:manifest`,
    chunkKeyPrefix: `${baseKey}:chunk:`,
  };
}

function describeCacheError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeCacheGet(key: string): Promise<unknown> {
  return runtimeCache.get(key).catch((error) => {
    console.warn(`Runtime cache read failed for ${key}: ${describeCacheError(error)}`);
    return undefined;
  });
}

function safeCacheSet(key: string, value: unknown): Promise<void> {
  return runtimeCache
    .set(key, value, { ttl: RUNTIME_CACHE_TTL_SECONDS, tags: RUNTIME_CACHE_TAGS })
    .catch((error) => {
      console.warn(`Runtime cache write failed for ${key}: ${describeCacheError(error)}`);
    });
}

async function readRuntimeCachedFile<T>(
  filePath: string,
  mtime: number,
  size: number,
): Promise<T[] | null> {
  const { manifestKey, chunkKeyPrefix } = getRuntimeCacheKeys(filePath, mtime, size);
  const manifest = await safeCacheGet(manifestKey);
  if (
    !isCsvCacheManifest(manifest) ||
    manifest.mtime !== mtime ||
    manifest.size !== size ||
    manifest.chunkCount < 1
  ) {
    return null;
  }

  const chunks = await Promise.all(
    Array.from({ length: manifest.chunkCount }, (_, index) => safeCacheGet(`${chunkKeyPrefix}${index}`)),
  );

  if (!chunks.every(Array.isArray)) {
    return null;
  }

  return chunks.flat() as T[];
}

async function writeRuntimeCachedFile(
  filePath: string,
  mtime: number,
  size: number,
  data: unknown[],
): Promise<void> {
  if (!shouldWriteRuntimeCache()) return;
  const { manifestKey, chunkKeyPrefix } = getRuntimeCacheKeys(filePath, mtime, size);
  const chunks: unknown[][] = [];
  let currentChunk: unknown[] = [];
  let currentSize = 2;

  for (const row of data) {
    const rowSize = JSON.stringify(row).length + 1;
    if (currentChunk.length > 0 && currentSize + rowSize > RUNTIME_CACHE_CHUNK_TARGET_BYTES) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 2;
    }
    currentChunk.push(row);
    currentSize += rowSize;
  }

  if (currentChunk.length > 0 || chunks.length === 0) {
    chunks.push(currentChunk);
  }

  await Promise.all(chunks.map((chunk, index) => safeCacheSet(`${chunkKeyPrefix}${index}`, chunk)));
  await safeCacheSet(manifestKey, { mtime, size, chunkCount: chunks.length });
}

export class LocalStorage implements IStorage {
  private getFilePath(index: string) {
    const filename = index.replace(/:/g, "-").replace(/\./g, "").toLowerCase();
    // Map legacy index names to new file names
    const mappedFilename = filename === "sp500" ? "index-sp" : filename === "nasdaq100" ? "index-nq" : filename;
    return join(DATA_DIR, `${mappedFilename}.csv`);
  }

  private async loadFile<T>(filePath: string, parser: (lines: string[]) => T[]): Promise<T[]> {
    try {
      const stats = await stat(filePath);
      const mtime = stats.mtimeMs;
      const size = stats.size;
      const cached = csvCache.get(filePath);

      if (cached && cached.mtime === mtime) {
        recordCsvCacheSource(filePath, "memory");
        return cached.data as T[];
      }

      const runtimeCached = await readRuntimeCachedFile<T>(filePath, mtime, size);
      if (runtimeCached) {
        csvCache.set(filePath, { data: runtimeCached, mtime });
        recordCsvCacheSource(filePath, "runtime");
        return runtimeCached;
      }

      const raw = await readFile(filePath, "utf-8");
      const lines = raw.trim().split("\n");
      const data = parser(lines);
      csvCache.set(filePath, { data, mtime });
      await writeRuntimeCachedFile(filePath, mtime, size, data);
      recordCsvCacheSource(filePath, "file");
      return data;
    } catch (error) {
      // If stat fails (e.g. file missing), we might still have a cached version
      // but it's safer to clear it if the file is truly gone.
      const cached = csvCache.get(filePath);
      if (cached) {
        recordCsvCacheSource(filePath, "fallback");
        return cached.data as T[];
      }
      console.error(`LocalStorage error reading ${filePath}:`, error);
      return [];
    }
  }

  /**
   * Full parsed series for `index`, memoized by loadFile. Callers that only
   * need endpoints must use this rather than a date-bounded getPrices call:
   * the filter allocates a fresh ~35,000-element array every time.
   */
  private async loadAllPrices(index: string): Promise<DailyPrice[]> {
    const path = this.getFilePath(index);
    return this.loadFile<DailyPrice>(path, (lines) => {
      const parsed: DailyPrice[] = [];
      const headers = lines[0].split(",");
      const indexOf = (name: string) => headers.indexOf(name);
      const adjOpenIdx = indexOf("adj_open");
      const adjCloseIdx = indexOf("adj_close");
      const openIdx = indexOf("open");
      const closeIdx = indexOf("close");
      const nameIdx = indexOf("name");
      const sourceIdx = indexOf("source");

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 4) continue;
        const dateStr = cols[0];
        // Normalize YYYY-MM to YYYY-MM-01
        const normalized = dateStr.length === 7 ? `${dateStr}-01` : dateStr;
        const hasAdjOpen = adjOpenIdx >= 0;
        const hasRawOpen = openIdx >= 0;
        const hasRawClose = closeIdx >= 0;
        const adjOpenRaw = hasAdjOpen ? cols[adjOpenIdx] : "";
        const adjOpen = adjOpenRaw !== "" ? Number(adjOpenRaw) : undefined;
        const adjCloseRaw = adjCloseIdx >= 0 ? cols[adjCloseIdx] : cols[hasAdjOpen ? 2 : 1];
        const adjClose = adjCloseRaw !== "" ? Number(adjCloseRaw) : undefined;
        const openRaw = hasRawOpen ? cols[openIdx] : "";
        const openParsed = openRaw !== "" ? Number(openRaw) : undefined;
        const closeRaw = hasRawClose ? cols[closeIdx] : adjCloseRaw;
        const close = closeRaw !== "" ? Number(closeRaw) : undefined;
        // Empty `open` cell means "open == close"; surface close so consumers see a usable open.
        const open = Number.isFinite(openParsed ?? NaN) ? openParsed : close;

        // Skip if both are missing or invalid
        if (!Number.isFinite(adjClose ?? NaN) && !Number.isFinite(close ?? NaN)) continue;

        parsed.push({
          date: normalized,
          adj_open: hasAdjOpen ? adjOpen : undefined,
          open: hasRawClose || hasRawOpen ? open : undefined,
          adj_close: adjClose,
          close,
          name: cols[nameIdx >= 0 ? nameIdx : hasAdjOpen ? 3 : 2],
          source: cols[sourceIdx >= 0 ? sourceIdx : hasAdjOpen ? 4 : 3],
        });
      }
      return parsed;
    });
  }

  async getPrices(index: string, startDate: string, endDate: string): Promise<DailyPrice[]> {
    const allPrices = await this.loadAllPrices(index);

    const startNormalized = startDate.length === 7 ? `${startDate}-01` : startDate;
    const endNormalized = endDate.length === 7 ? `${endDate}-01` : endDate;

    return allPrices.filter(p => p.date >= startNormalized && p.date <= endNormalized);
  }

  async getPriceDateBounds(index: string): Promise<{ minDate: string; maxDate: string } | null> {
    // Rows are parsed in file order and every data CSV is strictly ascending,
    // so the bounds are the endpoints -- no full copy needed.
    const prices = await this.loadAllPrices(index);
    if (prices.length === 0) return null;
    return {
      minDate: prices[0].date,
      maxDate: prices[prices.length - 1].date,
    };
  }

  async getInflation(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>> {
    const path = join(DATA_DIR, "inflation.csv");
    const allInflation = await this.loadFile<{ date: string; value: number }>(path, (lines) => {
      const parsed: Array<{ date: string; value: number }> = [];
      // Skip header: date,value,name,source
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 2) continue;
        const dateStr = cols[0];
        // Normalize to YYYY-MM-01 for consistent comparison
        const normalized = dateStr.length === 7 ? `${dateStr}-01` : dateStr;
        const value = Number(cols[1]);
        if (!Number.isFinite(value)) continue;
        parsed.push({ date: normalized, value });
      }
      return parsed.sort((a, b) => a.date.localeCompare(b.date));
    });

    return allInflation.filter(o => o.date >= startDate && o.date <= endDate);
  }

  async getBorrowRate(startDate: string, endDate: string): Promise<Array<{ date: string; value: number }>> {
    const path = join(DATA_DIR, "rate-borrow.csv");
    const allRates = await this.loadFile<{ date: string; value: number }>(path, (lines) => {
      const parsed: Array<{ date: string; value: number }> = [];
      // Skip header: date,value,name,source
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        if (cols.length < 2) continue;
        const value = Number(cols[1]);
        if (!Number.isFinite(value)) continue;
        parsed.push({ date: cols[0], value });
      }
      return parsed;
    });

    const startNormalized = startDate.length === 7 ? startDate + "-01" : startDate;
    const endNormalized = endDate.length === 7 ? endDate + "-01" : endDate;

    const inRangeRates = allRates.filter(r => {
      const dateNormalized = r.date.length === 7 ? r.date + "-01" : r.date;
      return dateNormalized >= startNormalized && dateNormalized <= endNormalized;
    });

    const carryInRate = [...allRates].reverse().find((r) => {
      const dateNormalized = r.date.length === 7 ? r.date + "-01" : r.date;
      return dateNormalized <= startNormalized;
    });

    if (!carryInRate) return inRangeRates;
    if (inRangeRates[0]?.date === carryInRate.date) return inRangeRates;
    return [carryInRate, ...inRangeRates];
  }
}

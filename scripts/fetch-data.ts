import { config } from "dotenv";
import { fileURLToPath } from "node:url";
config({ path: ".env.local" });

import { writeFile, readFile, open, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { CONSTANT_SP500_PROXY_START_DATE } from "../src/lib/constants";
import { computeAdjustedRebaseRatio } from "../src/lib/data/adjusted-rebase";
import { spliceFfLargeCapHistory } from "../src/lib/data/ff-large-cap-splice";
import {
  mergeAdjustedPricesWithRawIndexBars,
  mergeIncrementalIndexRows,
} from "../src/lib/data/index-provider-merge";
import {
  fetchYahooDailyBarsByDate,
  type YahooDailyBar,
} from "../src/lib/data/fetcher";
import type { DailyPrice } from "../src/lib/data/storage/types";
import { getNewYorkIsoDate } from "../src/lib/utils";

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Constants
// ============================================================================

const DATA_DIR = join(process.cwd(), "data");

/**
 * Format a *calculated* numeric CSV cell to at most 6 significant digits,
 * stripping trailing zeros. Daily price levels carry far less precision than
 * `String(num)` would suggest, so this keeps the on-disk artifacts compact.
 *
 * Only apply to values produced by our own math (ratios, ER drag, scaling).
 * Values fetched directly from an upstream API (e.g. raw FRED close prices)
 * are written through `String(n)` so we don't silently truncate vendor
 * precision.
 */
function fmt6(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Number(n.toPrecision(6)));
}

/** Stringify a fetched-from-API numeric cell verbatim (no rounding). */
function fmtRaw(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(n);
}

const ETFS = ["UPRO", "TQQQ", "SSO", "QLD"] as const;

// Annual expense ratios for risk-off ETFs, applied to proxy series before ETF inception.
// The actual ETFs embed these costs in their NAV, so the proxy must deduct them for parity.
const RISK_OFF_EXPENSE_RATIOS: Record<string, number> = {
  SGOV: 0.0009,  // 0.09%
  VGSH: 0.0004,  // 0.04%
  GLDM: 0.0010,  // 0.10%
};

// Annual expense ratios for equity ETF proxies. Applied to synthetic total-return
// series before the ETF's inception so pre-inception history matches what the
// ETF's NAV would have reported (real ETFs embed these costs in NAV).
const EQUITY_PROXY_EXPENSE_RATIOS = {
  VOO: 0.0003,  // 0.03%
  QQQ: 0.0018,  // 0.18%
} as const;

const TRADING_DAYS_PER_YEAR = 252;

// Nasdaq Composite dividend yields by year, 1971-1985.
// Used for the NDQ-TR synthetic total-return period before Nasdaq 100 inception.
const NASDAQ_COMPOSITE_DIVIDEND_YIELD: Record<number, number> = {
  1971: 0.0260, 1972: 0.0230, 1973: 0.0270, 1974: 0.0380, 1975: 0.0350,
  1976: 0.0310, 1977: 0.0335, 1978: 0.0380, 1979: 0.0380, 1980: 0.0330,
  1981: 0.0345, 1982: 0.0350, 1983: 0.0280, 1984: 0.0275, 1985: 0.0225,
};

// Nasdaq 100 dividend yields by year. Used for synthetic NDX-TR before QQQ.
const NASDAQ100_DIVIDEND_YIELD: Record<number, number> = {
  1985: 0.0120, 1986: 0.0110, 1987: 0.0100, 1988: 0.0095, 1989: 0.0085,
  1990: 0.0080, 1991: 0.0075, 1992: 0.0060, 1993: 0.0050, 1994: 0.0045,
  1995: 0.0035, 1996: 0.0025, 1997: 0.0018, 1998: 0.0012,
  1999: 0.0008, 2000: 0.0008, 2001: 0.0015, 2002: 0.0020, 2003: 0.0015,
  2004: 0.0025, 2005: 0.0022, 2006: 0.0025, 2007: 0.0033, 2008: 0.0095,
  2009: 0.0070, 2010: 0.0058, 2011: 0.0083, 2012: 0.0102, 2013: 0.0125,
  2014: 0.0129, 2015: 0.0105, 2016: 0.0091, 2017: 0.0077, 2018: 0.0088,
  2019: 0.0071, 2020: 0.0053, 2021: 0.0045, 2022: 0.0072, 2023: 0.0060,
  2024: 0.0058, 2025: 0.0060,
};

// ============================================================================
// Helpers
// ============================================================================

async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastError;
}



type ExistingCsv = {
  header: string;
  rows: string[][];
};

type CsvTail = {
  header: string;
  lastRow: string[];
};

async function readExistingCsv(filename: string): Promise<ExistingCsv | null> {
  const filePath = join(DATA_DIR, filename);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  return {
    header: lines[0],
    rows: lines.slice(1).map((line) => line.split(",")),
  };
}

function extractLastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line !== "") return line;
  }
  return null;
}

async function readFirstLine(fileHandle: Awaited<ReturnType<typeof open>>, fileSize: number): Promise<string | null> {
  let offset = 0;
  let collected = "";
  const chunkSize = 1024;

  while (offset < fileSize) {
    const length = Math.min(chunkSize, fileSize - offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) break;
    collected += buffer.toString("utf8", 0, bytesRead);
    const newlineIdx = collected.search(/\r?\n/);
    if (newlineIdx !== -1) {
      return collected.slice(0, newlineIdx);
    }
    offset += bytesRead;
  }

  return collected.trim() === "" ? null : collected;
}

async function readCsvTail(filename: string): Promise<CsvTail | null> {
  const filePath = join(DATA_DIR, filename);
  if (!existsSync(filePath)) return null;

  const fileHandle = await open(filePath, "r");

  try {
    const { size } = await fileHandle.stat();
    if (size === 0) return null;

    const header = await readFirstLine(fileHandle, size);
    if (!header) return null;

    const chunkSize = 4096;
    let position = size;
    let collected = "";

    while (position > 0) {
      const start = Math.max(0, position - chunkSize);
      const length = position - start;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
      if (bytesRead <= 0) break;

      collected = buffer.toString("utf8", 0, bytesRead) + collected;
      const lineMatches = collected.match(/[^\r\n]+/g);
      if (lineMatches && lineMatches.length >= 2) {
        return {
          header,
          lastRow: lineMatches[lineMatches.length - 1].split(","),
        };
      }

      position = start;
    }

    const onlyLine = extractLastNonEmptyLine(collected);
    if (!onlyLine || onlyLine === header) return null;

    return {
      header,
      lastRow: onlyLine.split(","),
    };
  } finally {
    await fileHandle.close();
  }
}

function writeCsvRows(filename: string, header: string, rows: string[][]): Promise<void> {
  const filePath = join(DATA_DIR, filename);
  const csv = [header, ...rows.map((row) => row.join(","))].join("\n");
  return writeFile(filePath, csv);
}

async function appendCsvRows(filename: string, rows: string[][]): Promise<void> {
  if (rows.length === 0) return;
  const filePath = join(DATA_DIR, filename);
  const csv = `\n${rows.map((row) => row.join(",")).join("\n")}`;
  await appendFile(filePath, csv);
}

function nearlyEqual(a: number, b: number, tolerance = 1e-8): boolean {
  if (!isFinite(a) || !isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerance * scale;
}

function isUpToDateForNewYork(lastStoredDate: string): boolean {
  return lastStoredDate >= getNewYorkIsoDate();
}

function findOverlapRow<T extends { date: string }>(rows: T[], overlapDate: string): T | undefined {
  return rows.find((row) => row.date === overlapDate);
}

async function buildAndWritePriceCsv(params: {
  filename: string;
  label: string;
  fetchFullRows: () => Promise<DailyPrice[]>;
  validate?: (rows: DailyPrice[], filename: string) => void;
  gapThreshold?: number;
  includeAdjOpen?: boolean;
}): Promise<void> {
  const rows = await params.fetchFullRows();
  console.log(`  Got ${rows.length} rows`);
  checkForLags(rows, params.filename, params.gapThreshold);
  (params.validate ?? ((priceRows: DailyPrice[], filename: string) => {
    validateRows(priceRows as Array<{ date: string; adj_close: number; adj_open?: number }>, filename);
    validatePriceContinuity(priceRows as Array<{ date: string; adj_close: number }>, filename);
  }))(rows, params.filename);
  const includeAdjOpen = Boolean(params.includeAdjOpen);
  await writeCsvRows(
    params.filename,
    includeAdjOpen ? "date,adj_open,adj_close,name,source" : "date,adj_close,name,source",
    rows.map((row) =>
      includeAdjOpen
        ? [row.date, row.adj_open != null && row.adj_open !== row.adj_close ? fmt6(row.adj_open) : "", fmt6(row.adj_close), row.name, row.source]
        : [row.date, fmt6(row.adj_close), row.name, row.source]
    )
  );
  console.log(`\n✓ Written to ${params.filename}`);
}

async function buildAndWriteIndexCsv(params: {
  filename: string;
  fetchFullRows: () => Promise<DailyPrice[]>;
}): Promise<void> {
  const rows = await params.fetchFullRows();
  console.log(`  Got ${rows.length} rows`);
  validateIndexRowsAllowingRecentPartialTail(rows, params.filename);
  await writeCsvRows(
    params.filename,
    "date,adj_close,open,close,name,source",
    rows.map(serializeIndexCsvRow)
  );
  console.log(`\n✓ Written to ${params.filename}`);
}

async function buildAndWriteValueCsv(params: {
  filename: string;
  rows: Array<{ date: string; value: number; name: string; source: string }>;
}): Promise<void> {
  console.log(`  Got ${params.rows.length} rows`);
  checkForLags(params.rows, params.filename, params.filename === "rate-borrow.csv" ? 10 : 35);
  await writeCsvRows(
    params.filename,
    "date,value,name,source",
    params.rows.map((row) => [row.date, fmt6(row.value), row.name, row.source])
  );
  console.log(`\n✓ Written to ${params.filename}`);
}

async function rebuildOrKeepExisting(filename: string, rebuild: () => Promise<void>): Promise<void> {
  try {
    await rebuild();
  } catch (err) {
    if (!existsSync(join(DATA_DIR, filename))) {
      throw err;
    }
    console.warn(
      `  ! Full rebuild failed for ${filename}; keeping existing data/${filename}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function validateExistingSimplePriceCsv(filename: string): Promise<boolean> {
  const existing = await readExistingCsv(filename);
  if (!existing) return true;

  try {
    const hasAdjOpen = existing.header.startsWith("date,adj_open,adj_close");
    const rows: DailyPrice[] = existing.rows.map((row) => ({
      date: row[0],
      adj_open: hasAdjOpen && row[1] !== "" ? Number(row[1]) : undefined,
      adj_close: Number(row[hasAdjOpen ? 2 : 1]),
      name: row[hasAdjOpen ? 3 : 2] ?? "",
      source: row[hasAdjOpen ? 4 : 3] ?? "",
    }));
    validateRows(rows as Array<{ date: string; adj_close: number; adj_open?: number }>, filename);
    validatePriceContinuity(rows as Array<{ date: string; adj_close: number }>, filename);
    return true;
  } catch {
    return false;
  }
}

async function validateExistingIndexCsv(filename: string): Promise<boolean> {
  const existing = await readExistingCsv(filename);
  if (!existing) return true;

  try {
    const rows = parseIndexCsvRows(existing.rows);
    validateIndexRowsAllowingRecentPartialTail(rows, filename);
    return true;
  } catch (err) {
    console.error(`  ! ${filename} validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function generateIncrementalSimplePriceCsv(params: {
  filename: string;
  label: string;
  fetchFreshRows: (startDate: string) => Promise<DailyPrice[]>;
  fetchFullRows: () => Promise<DailyPrice[]>;
  allowRatioRebaseOnMismatch: boolean;
  gapThreshold?: number;
  includeAdjOpen?: boolean;
  forceRebuild?: boolean;
}): Promise<void> {
  console.log(`=== Generating ${params.filename} (${params.label}) ===\n`);

  if (params.forceRebuild) {
    console.log(`  ! Force rebuild requested for ${params.filename}`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  const existingTail = await readCsvTail(params.filename);
  if (!existingTail) {
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  const hasAdjOpen = existingTail.header.startsWith("date,adj_open,adj_close");
  if (params.includeAdjOpen && !hasAdjOpen) {
    console.log(`  ! ${params.filename} missing adj_open column; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: true,
    }));
    return;
  }

  const existingIsValid = await validateExistingSimplePriceCsv(params.filename);
  if (!existingIsValid) {
    console.log(`  ! ${params.filename} existing rows look broken; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  const lastRow = existingTail.lastRow;
  const lastDate = lastRow[0];
  if (isUpToDateForNewYork(lastDate)) {
    console.log(`  ✓ ${params.filename} already current through ${lastDate} (New York date), skipped`);
    return;
  }

  let freshRows: DailyPrice[];
  try {
    freshRows = await params.fetchFreshRows(lastDate);
  } catch (err) {
    console.log(`  ! Fresh-row fetch failed for ${params.filename}: ${err instanceof Error ? err.message : err}`);
    console.log(`    Rebuilding full file...`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      // Must be carried through: omitting it rebuilds the file without its
      // adj_open column, NaN-ing every next-day-open fill for that asset until
      // a later run happens to rebuild again.
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }
  if (freshRows.length === 0) {
    console.log(`  ✓ No realtime rows returned for ${params.filename}, skipped`);
    return;
  }

  const overlap = findOverlapRow(freshRows, lastDate);
  if (!overlap) {
    console.log(`  ! Overlap row missing for ${params.filename}; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      // Must be carried through: omitting it rebuilds the file without its
      // adj_open column, NaN-ing every next-day-open fill for that asset until
      // a later run happens to rebuild again.
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  const storedAdjClose = Number(lastRow[hasAdjOpen ? 2 : 1]);
  if (overlap.adj_close === undefined) {
    console.log(`  ! Overlap row for ${params.filename} is missing adj_close; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  if (nearlyEqual(storedAdjClose, overlap.adj_close)) {
    const newerRows = freshRows.filter((row) => row.date > lastDate);
    if (newerRows.length === 0) {
      console.log(`  ✓ ${params.filename} overlap matched and no newer rows were available`);
      return;
    }
    await appendCsvRows(
      params.filename,
      newerRows.map((row) =>
        hasAdjOpen
          ? [row.date, row.adj_open != null && row.adj_open !== row.adj_close ? fmt6(row.adj_open) : "", fmt6(row.adj_close), row.name, row.source]
          : [row.date, fmt6(row.adj_close), row.name, row.source]
      )
    );
    console.log(`  ✓ ${params.filename} appended ${newerRows.length} rows`);
    return;
  }

  if (!params.allowRatioRebaseOnMismatch) {
    console.log(`  ! Overlap mismatch for ${params.filename}; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWritePriceCsv({
      filename: params.filename,
      label: params.label,
      fetchFullRows: params.fetchFullRows,
      gapThreshold: params.gapThreshold,
      includeAdjOpen: params.includeAdjOpen,
    }));
    return;
  }

  const ratio = overlap.adj_close / storedAdjClose;
  const existing = await readExistingCsv(params.filename);
  if (!existing || existing.rows.length === 0) {
    throw new Error(`Failed to read existing rows for ${params.filename} rebase`);
  }
  const rebasedRows = existing.rows.map((row) =>
    hasAdjOpen
      ? [
          row[0],
          row[1] !== "" ? fmt6(Number(row[1]) * ratio) : "",
          fmt6(Number(row[2]) * ratio),
          row[3],
          row[4],
        ]
      : [row[0], fmt6(Number(row[1]) * ratio), row[2], row[3]]
  );
  const newerRows = freshRows.filter((row) => row.date > lastDate);
  rebasedRows.push(
    ...newerRows.map((row) =>
      hasAdjOpen
        ? [row.date, row.adj_open != null && row.adj_open !== row.adj_close ? fmt6(row.adj_open) : "", fmt6(row.adj_close), row.name, row.source]
        : [row.date, fmt6(row.adj_close), row.name, row.source]
    )
  );
  await writeCsvRows(params.filename, existing.header, rebasedRows);
  console.log(`  ✓ ${params.filename} rebased and appended ${newerRows.length} rows`);
}

async function generateIncrementalValueCsv(params: {
  filename: string;
  label: string;
  fetchFreshRows: (startDate: string) => Promise<Array<{ date: string; value: number; name: string; source: string }>>;
  fetchFullRows: (tailDate?: string) => Promise<Array<{ date: string; value: number; name: string; source: string }>>;
  forceRebuild?: boolean;
}): Promise<void> {
  console.log(`=== Generating ${params.filename} (${params.label}) ===\n`);

  const existingTail = await readCsvTail(params.filename);

  if (params.forceRebuild) {
    console.log(`  ! Force rebuild requested for ${params.filename}`);
    await rebuildOrKeepExisting(params.filename, async () => {
      const rows = await params.fetchFullRows();
      await buildAndWriteValueCsv({ filename: params.filename, rows });
    });
    return;
  }

  if (!existingTail) {
    await rebuildOrKeepExisting(params.filename, async () => {
      const rows = await params.fetchFullRows();
      await buildAndWriteValueCsv({ filename: params.filename, rows });
    });
    return;
  }

  const lastRow = existingTail.lastRow;
  const lastDate = lastRow[0];
  if (isUpToDateForNewYork(lastDate)) {
    console.log(`  ✓ ${params.filename} already current through ${lastDate} (New York date), skipped`);
    return;
  }

  let freshRows: Array<{ date: string; value: number; name: string; source: string }>;
  try {
    freshRows = await params.fetchFreshRows(lastDate);
  } catch (err) {
    console.log(`  ! Fresh-row fetch failed for ${params.filename}: ${err instanceof Error ? err.message : err}`);
    console.log(`    Rebuilding full file...`);
    await rebuildOrKeepExisting(params.filename, async () => {
      const fullRows = await params.fetchFullRows();
      await buildAndWriteValueCsv({ filename: params.filename, rows: fullRows });
    });
    return;
  }
  if (freshRows.length === 0) {
    console.log(`  ✓ No realtime rows returned for ${params.filename}, skipped`);
    return;
  }

  const overlap = findOverlapRow(freshRows, lastDate);
  if (!overlap) {
    console.log(`  ! Overlap row missing for ${params.filename}; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, async () => {
      const fullRows = await params.fetchFullRows();
      await buildAndWriteValueCsv({ filename: params.filename, rows: fullRows });
    });
    return;
  }

  const storedValue = Number(lastRow[1]);
  if (!nearlyEqual(storedValue, overlap.value, 1e-10)) {
    console.log(`  ! Overlap mismatch for ${params.filename}; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, async () => {
      const fullRows = await params.fetchFullRows();
      await buildAndWriteValueCsv({ filename: params.filename, rows: fullRows });
    });
    return;
  }

  const newerRows = freshRows.filter((row) => row.date > lastDate);
  if (newerRows.length === 0) {
    console.log(`  ✓ ${params.filename} overlap matched and no newer rows were available`);
    return;
  }

  await appendCsvRows(
    params.filename,
    newerRows.map((row) => [row.date, fmt6(row.value), row.name, row.source])
  );
  console.log(`  ✓ ${params.filename} appended ${newerRows.length} rows`);
}

async function generateIncrementalIndexCsv(params: {
  filename: string;
  label: string;
  fetchFreshRows: (startDate: string) => Promise<DailyPrice[]>;
  fetchFullRows: () => Promise<DailyPrice[]>;
  forceRebuild?: boolean;
  yahooSymbol?: "^GSPC" | "^NDX";
  modernName?: "VOO" | "QQQ";
}): Promise<void> {
  console.log(`=== Generating ${params.filename} (${params.label}) ===\n`);

  if (params.forceRebuild) {
    console.log(`  ! Force rebuild requested for ${params.filename}`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }

  const existing = await readExistingCsv(params.filename);
  if (!existing) {
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }

  const existingIsValid = await validateExistingIndexCsv(params.filename);
  if (!existingIsValid) {
    console.log(`  ! ${params.filename} existing rows look broken; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }

  const parsedRows = parseIndexCsvRows(existing.rows);
  const lastRow = parsedRows[parsedRows.length - 1];
  const lastDate = lastRow.date;
  const lastAdjClose = lastRow.adj_close;
  const lastRawClose = lastRow.close ?? 0;
  const lastName = lastRow.name;

  const hasBrokenModernRawClose =
    lastAdjClose !== undefined &&
    (lastName === "VOO" || lastName === "QQQ") &&
    nearlyEqual(lastAdjClose, lastRawClose);

  if (hasBrokenModernRawClose) {
    console.log(`  ! ${params.filename} tail raw close looks broken; rebuilding full file`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }

  const partialTailRows = getTrailingIndexRowsMissingAdjustedData(parsedRows);
  const earliestBackfillDate = partialTailRows[0]?.date;
  const tiingoFetchStart = indexIncrementalTiingoFetchStart(lastDate, earliestBackfillDate);
  const isCurrent = isUpToDateForNewYork(lastDate);

  let freshRows: DailyPrice[];
  try {
    freshRows = await params.fetchFreshRows(tiingoFetchStart);
  } catch (err) {
    console.log(`  ! Fresh-row fetch failed for ${params.filename}: ${err instanceof Error ? err.message : err}`);
    console.log(`    Rebuilding full file...`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }
  const freshByDate = new Map(freshRows.map((row) => [row.date, row]));

  if (freshRows.length === 0 && partialTailRows.length === 0 && isCurrent) {
    console.log(`  ✓ ${params.filename} already current through ${lastDate} (New York date), skipped`);
    return;
  }

  // Rows previously stored with a provisional adj_close (placeholder used
  // when Tiingo's authoritative value wasn't yet available) are always
  // overwritten by the fresh value, so they don't participate in overlap
  // comparison.
  const overlapPairs = parsedRows.flatMap((row) => {
    const fresh = freshByDate.get(row.date);
    if (!fresh || row.adj_close == null || fresh.adj_close == null) return [];
    if (row.source?.includes("provisional") === true) return [];
    return [{ date: row.date, stored: row.adj_close, fresh: fresh.adj_close }];
  });

  let rebaseRatio: number | null;
  try {
    rebaseRatio = computeAdjustedRebaseRatio(overlapPairs);
  } catch (err) {
    // Non-uniform overlap usually means a provider corrected individual rows.
    // Refuse to guess a rebase factor — rebuild the full series from sources
    // instead of aborting the incremental update and leaving the CSV stale.
    console.log(
      `  ! Overlap mismatch for ${params.filename}: ${err instanceof Error ? err.message : err}`
    );
    console.log(`    Rebuilding full file...`);
    await rebuildOrKeepExisting(params.filename, () => buildAndWriteIndexCsv({
      filename: params.filename,
      fetchFullRows: params.fetchFullRows,
    }));
    return;
  }
  if (rebaseRatio != null) {
    console.log(
      `  ! ${params.filename} adjusted closes shifted uniformly by ${rebaseRatio.toFixed(8)} across ${overlapPairs.length} overlap row(s); re-basing older rows (dividend/split re-adjustment)`
    );
  }

  const incrementalMerge = mergeIncrementalIndexRows({
    storedRows: parsedRows,
    freshRows,
    rebaseRatio,
  });
  const mergedRows = incrementalMerge.rows;
  let changed = incrementalMerge.changed;

  if (params.yahooSymbol) {
    const modernName = params.modernName ?? (params.yahooSymbol === "^GSPC" ? "VOO" : "QQQ");

    try {
      const yahooRowsForMerge = await fetchYahooIndexBars(params.yahooSymbol, { startDate: tiingoFetchStart });
      const yahooByDate = new Map(yahooRowsForMerge.map((row) => [row.date, row]));
      for (const row of mergedRows) {
        if (row.name !== modernName) continue;
        const yBar = yahooByDate.get(row.date);
        if (yBar == null) continue;
        row.open = yBar.open;
        row.close = yBar.close;
        row.source = "yahoo(open+close)+tiingo(adj_close)";
        changed = true;
      }

      const appended = appendProvisionalYahooRows(mergedRows, yahooRowsForMerge, modernName);
      if (appended > 0) {
        changed = true;
        console.log(`  ✓ ${params.filename} appended ${appended} provisional Yahoo row(s)`);
      }
    } catch (err) {
      console.warn(`  ! Yahoo Finance daily-chart merge failed for ${params.filename}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!changed) {
    console.log(`  ✓ ${params.filename} overlap matched and no newer rows were available`);
    return;
  }

  mergedRows.sort((a, b) => a.date.localeCompare(b.date));
  validateIndexRowsAllowingRecentPartialTail(mergedRows, params.filename);
  await writeCsvRows(params.filename, "date,adj_close,open,close,name,source", mergedRows.map(serializeIndexCsvRow));
  console.log(`  ✓ ${params.filename} updated (${partialTailRows.length} partial tail rows backfilled, ${incrementalMerge.appendedCount} full rows appended)`);
}

/**
 * Stitch historical proxy data to modern actual data with proper boundary handling.
 *
 * Scales historical prices so that the price on the boundary date matches the first modern price.
 * This preserves the daily return between the last historical day and first modern day.
 *
 * @param modernRows - Modern data from Tiingo (actual prices)
 * @param historicalRows - Historical proxy data (will be scaled)
 * @param modernName - Name for modern data rows
 * @param modernSource - Source for modern data rows
 * @param historicalName - Name for historical data rows
 * @param historicalSource - Source for historical data rows
 * @returns Combined array with scaled historical data + modern data
 */
function stitchBoundary(
  modernRows: Array<{ date: string; adjClose: number; adjOpen?: number }>,
  historicalRows: Array<{ date: string; close: number } | DailyPrice>,
  modernName: string,
  modernSource: string,
  historicalName: string,
  historicalSource: string
): DailyPrice[] {
  if (modernRows.length === 0) {
    throw new Error("No modern data provided for stitching");
  }

  const modernFirstDate = modernRows[0].date;
  const modernFirstPrice = modernRows[0].adjClose;

  // Find historical price on the modern first date (for scaling)
  const historicalOnModernFirst = historicalRows.find(r => r.date === modernFirstDate);

  if (!historicalOnModernFirst) {
    throw new Error(`No historical data available for boundary date ${modernFirstDate}`);
  }

  // Filter historical to only pre-modern dates (before first modern date)
  const historicalPreModern = historicalRows.filter(r => r.date < modernFirstDate);

  if (historicalPreModern.length === 0) {
    throw new Error("No historical data available before modern start date");
  }
// Get close price from historical row (handles both {close} and {adj_close} formats)
  const getHistoricalClose = (row: { date: string; close: number } | DailyPrice): number => {
    return ("close" in row && row.close !== undefined) ? row.close : ((row as DailyPrice).adj_close as number);
  };

  // Scale historical prices so that the price on modern's first date matches modern's first price
  // This preserves the daily return from the last historical day to the first modern day
  // Formula: scale = modern_first / historical_on_modern_first_date
  const scale = modernFirstPrice / getHistoricalClose(historicalOnModernFirst);

  const historicalPrices: DailyPrice[] = historicalPreModern.map(r => ({
    date: r.date,
    adj_close: getHistoricalClose(r) * scale,
    close: getHistoricalClose(r),
    name: historicalName,
    source: historicalSource,
  }));

  const modernPrices: DailyPrice[] = modernRows.map(r => ({
    date: r.date,
    adj_open: r.adjOpen ?? r.adjClose,
    adj_close: r.adjClose,
    close: r.adjClose,
    name: modernName,
    source: modernSource,
  }));

  return [...historicalPrices, ...modernPrices];
}

/**
 * Apply a compounding daily expense-ratio drag to pre-inception rows so a
 * synthetic total-return proxy behaves like the real ETF's NAV would have.
 *
 * The post-inception anchor is preserved: for each pre-inception day i, the
 * adjusted close is rebuilt so its daily return equals the original return
 * minus `annualER / TRADING_DAYS_PER_YEAR`. This makes pre-inception values
 * larger than the raw TR (they now represent an ER-embedded NAV that must
 * end at the same value on inception day).
 */
function applyPreInceptionExpenseDrag(
  rows: DailyPrice[],
  inceptionDate: string,
  annualER: number
): DailyPrice[] {
  if (annualER <= 0 || rows.length === 0) return rows;
  const dailyER = annualER / TRADING_DAYS_PER_YEAR;
  const anchorIdx = rows.findIndex((r) => r.date >= inceptionDate);
  if (anchorIdx <= 0) return rows;

  const adjusted: DailyPrice[] = rows.slice();
  for (let i = anchorIdx - 1; i >= 0; i--) {
    const origCloseNext = rows[i + 1].adj_close;
    const origCloseCurr = rows[i].adj_close;
    if (
      origCloseNext == null ||
      origCloseCurr == null ||
      !isFinite(origCloseNext) ||
      !isFinite(origCloseCurr) ||
      origCloseCurr <= 0
    ) {
      continue;
    }
    const origReturn = origCloseNext / origCloseCurr - 1;
    const adjustedReturn = origReturn - dailyER;
    const nextAdjustedClose = adjusted[i + 1].adj_close as number;
    adjusted[i] = {
      ...rows[i],
      adj_close: nextAdjustedClose / (1 + adjustedReturn),
    };
  }
  return adjusted;
}

/**
 * Check for date gaps in a series of rows.
 */
function checkForLags(rows: Array<{ date: string }>, filename: string, maxGapDays = 10): void {
  const gaps: Array<{ prev: string; curr: string; days: number }> = [];
  let prevDate: string | null = null;

  const marketClosures = [
    { start: "1914-07-31", end: "1914-12-12", reason: "WWI" },
    { start: "1933-03-04", end: "1933-03-15", reason: "Bank Holiday" },
    { start: "2001-09-11", end: "2001-09-17", reason: "9/11" },
  ];

  const isKnownClosure = (prev: string, curr: string) => {
    return marketClosures.some(c => prev <= c.end && curr >= c.start);
  };

  for (const row of rows) {
    if (prevDate) {
      const prev = new Date(prevDate);
      const curr = new Date(row.date);
      const diffDays = Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays > maxGapDays && !isKnownClosure(prevDate, row.date)) {
        gaps.push({ prev: prevDate, curr: row.date, days: diffDays });
      }
    }
    prevDate = row.date;
  }

  if (gaps.length > 0) {
    console.warn(`\n⚠️  WARNING: ${filename} has ${gaps.length} date gaps (> ${maxGapDays} days):`);
    gaps.slice(0, 10).forEach(g => {
      console.warn(`   ${g.prev} → ${g.curr} (${g.days} days)`);
    });
    if (gaps.length > 10) {
      console.warn(`   ... and ${gaps.length - 10} more gaps`);
    }
  } else {
    console.log(`  ✓ No date gaps detected (threshold: ${maxGapDays} days, excluding known market closures)`);
  }
}

/**
 * Validate rows for extreme values, NaN, and Infinity.
 */
function validateRows(rows: Array<{ date: string; adj_close: number; adj_open?: number }>, filename: string, requireAdjOpen = false): void {
  const issues: string[] = [];

  for (const row of rows) {
    if (isNaN(row.adj_close)) {
      issues.push(`${row.date}: NaN value`);
    } else if (!isFinite(row.adj_close)) {
      issues.push(`${row.date}: Infinite value`);
    } else if (row.adj_close <= 0) {
      issues.push(`${row.date}: Non-positive value ${row.adj_close}`);
    }

    if (row.adj_open !== undefined) {
      if (isNaN(row.adj_open)) {
        issues.push(`${row.date}: NaN open value`);
      } else if (!isFinite(row.adj_open)) {
        issues.push(`${row.date}: Infinite open value`);
      } else if (row.adj_open <= 0) {
        issues.push(`${row.date}: Non-positive open value ${row.adj_open}`);
      }
    } else if (requireAdjOpen) {
      issues.push(`${row.date}: Missing adj_open`);
    }
  }

  if (issues.length > 0) {
    console.error(`\n❌ ERROR: Validation failed for ${filename}:`);
    issues.slice(0, 10).forEach(issue => console.error(`   - ${issue}`));
    if (issues.length > 10) console.error(`   ... and ${issues.length - 10} more issues`);
    throw new Error(`Validation failed for ${filename}`);
  }

  console.log(`  ✓ Validation passed (${rows.length} rows)`);
}

function validatePriceContinuity(rows: Array<{ date: string; adj_close: number }>, filename: string, jumpThreshold = 4): void {
  const discontinuities: string[] = [];
  let prev: { date: string; adj_close: number } | null = null;

  for (const row of rows) {
    if (!isFinite(row.adj_close) || row.adj_close <= 0) {
      prev = row;
      continue;
    }

    if (prev && isFinite(prev.adj_close) && prev.adj_close > 0) {
      const jump = Math.max(row.adj_close / prev.adj_close, prev.adj_close / row.adj_close);
      if (jump > jumpThreshold) {
        discontinuities.push(
          `${prev.date} -> ${row.date}: adj_close jumped from ${prev.adj_close} to ${row.adj_close}`
        );
      }
    }

    prev = row;
  }

  if (discontinuities.length > 0) {
    console.error(`\n❌ ERROR: Validation failed for ${filename}: price continuity issues detected`);
    discontinuities.slice(0, 10).forEach((issue) => console.error(`   - ${issue}`));
    if (discontinuities.length > 10) console.error(`   ... and ${discontinuities.length - 10} more issues`);
    throw new Error(`Validation failed for ${filename}`);
  }

  console.log(`  ✓ Price continuity passed (${rows.length} rows)`);
}

function validateIndexRowsAllowingRecentPartialTail(rows: DailyPrice[], filename: string): void {
  const partialTailAllowance = 10;
  const partialTailRows = getTrailingIndexRowsMissingAdjustedData(rows);

  if (partialTailRows.length > partialTailAllowance) {
    throw new Error(`Validation failed for ${filename}: too many trailing rows missing adjusted data (${partialTailRows.length} > ${partialTailAllowance})`);
  }

  const fullRows: DailyPrice[] = [];
  const partialTailDates = new Set(partialTailRows.map((r) => r.date));

  for (const row of rows) {
    const hasAdjClose = isFinite(row.adj_close ?? Number.NaN) && (row.adj_close ?? 0) > 0;
    if (!hasAdjClose) {
      if (!partialTailDates.has(row.date)) {
        throw new Error(`Validation failed for ${filename}: missing adj_close outside trailing ${partialTailAllowance} rows on ${row.date}`);
      }
      continue;
    }
    fullRows.push(row);
  }

  validateRows(fullRows as Array<{ date: string; adj_close: number; adj_open?: number }>, filename, false);
  validatePriceContinuity(fullRows as Array<{ date: string; adj_close: number }>, filename);

  // Allow the same trailing window to be missing raw close (e.g. Yahoo close
  // unavailable during the current session; FRED backfill arrives next run).
  const trailingCloseMissing: DailyPrice[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const hasClose = isFinite(row.close ?? NaN) && (row.close ?? 0) > 0;
    if (!hasClose) trailingCloseMissing.unshift(row);
    else break;
  }
  const trailingCloseDates = new Set(trailingCloseMissing.map((r) => r.date));
  const missingClose = rows.filter((row) => {
    const hasClose = isFinite(row.close ?? NaN) && (row.close ?? 0) > 0;
    return !hasClose && !trailingCloseDates.has(row.date);
  });
  if (missingClose.length > 0) {
    console.error(`\n❌ ERROR: Validation failed for ${filename}: missing raw close values`);
    missingClose.slice(0, 10).forEach((row) => console.error(`   - ${row.date}: invalid close ${row.close}`));
    if (missingClose.length > 10) console.error(`   ... and ${missingClose.length - 10} more issues`);
    throw new Error(`Validation failed for ${filename}`);
  }
  if (trailingCloseMissing.length > partialTailAllowance) {
    throw new Error(`Validation failed for ${filename}: too many trailing rows missing raw close (${trailingCloseMissing.length} > ${partialTailAllowance})`);
  }
  if (trailingCloseMissing.length > 0) {
    console.log(`  ✓ Raw close validation passed (${rows.length} rows, ${trailingCloseMissing.length} trailing tail allowed missing)`);
  } else {
    console.log(`  ✓ Raw close validation passed (${rows.length} rows)`);
  }

  const ratioDiscontinuities: string[] = [];
  let prevRatio: number | null = null;
  let prevDate: string | null = null;

  for (const row of rows) {
    const rawClose = row.close;
    const adjClose = row.adj_close ?? Number.NaN;
    if (rawClose === undefined || !isFinite(rawClose) || !isFinite(adjClose) || adjClose <= 0 || rawClose <= 0) {
      continue;
    }

    const ratio = rawClose / adjClose;
    if (prevRatio !== null && prevDate !== null) {
      const change = ratio / prevRatio;
      if (!isFinite(change) || change < 0.75 || change > 1.25) {
        ratioDiscontinuities.push(
          `${prevDate} -> ${row.date}: raw/adj ratio jumped from ${prevRatio.toFixed(6)} to ${ratio.toFixed(6)}`
        );
      }
    }

    prevRatio = ratio;
    prevDate = row.date;
  }

  if (ratioDiscontinuities.length > 0) {
    console.error(`\n❌ ERROR: Validation failed for ${filename}: raw/adjusted scale discontinuities detected`);
    ratioDiscontinuities.slice(0, 10).forEach((issue) => console.error(`   - ${issue}`));
    if (ratioDiscontinuities.length > 10) {
      console.error(`   ... and ${ratioDiscontinuities.length - 10} more issues`);
    }
    throw new Error(`Validation failed for ${filename}`);
  }

  console.log(`  ✓ Raw/adjusted scale continuity passed (${rows.length} rows)`);
}

// ============================================================================
// Data Fetchers
// ============================================================================

type TiingoEtfRow = {
  date: string;
  adjClose: number;
  adjOpen: number;
};

async function fetchTiingoRows(ticker: string, startDate?: string): Promise<TiingoEtfRow[]> {
  const apiKey = process.env.TIINGO_API_KEY;
  if (!apiKey) throw new Error("TIINGO_API_KEY not configured");

  const symbol = ticker.toLowerCase().replace(".", "-");
  const effectiveStartDate = startDate ?? "1900-01-01";
  const url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${effectiveStartDate}`;

  const response = await withRetry(
    () =>
      fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: { "Content-Type": "application/json", Authorization: `Token ${apiKey}` },
      }),
    2,
    1000
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Tiingo API error (${response.status}) for ${symbol}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as Array<{
    date: string;
    adjClose: number;
    adjOpen?: number;
  }>;
  if (!Array.isArray(data) || data.length === 0) return [];

  return data
    .filter((d) => isFinite(d.adjClose) && d.adjClose > 0)
    .map((d) => {
      const adjClose = d.adjClose;
      const adjOpen =
        isFinite(d.adjOpen ?? Number.NaN) && (d.adjOpen ?? 0) > 0 ? (d.adjOpen as number) : adjClose;
      return {
        date: d.date.slice(0, 10),
        adjClose,
        adjOpen,
      };
  });
}

const yahooIndexBarsCache = new Map<string, Map<string, YahooDailyBar>>();

async function fetchYahooIndexBars(
  yahooSymbol: "^GSPC" | "^NDX" | "^IXIC",
  options: { startDate?: string; endDate?: string; fullHistory?: boolean } = {}
): Promise<Array<{ date: string; open: number; close: number; source: "yahoo" }>> {
  const requestCacheKey = options.fullHistory
    ? `${yahooSymbol}:full`
    : `${yahooSymbol}:recent:${options.startDate ?? "1mo"}`;
  let yahooByDate = yahooIndexBarsCache.get(requestCacheKey);

  if (!yahooByDate) {
    yahooByDate = await fetchYahooDailyBarsByDate(yahooSymbol, {
      fullHistory: options.fullHistory,
      startDate: options.fullHistory ? undefined : options.startDate,
    });
    yahooIndexBarsCache.set(requestCacheKey, yahooByDate);
  }

  return Array.from(yahooByDate.entries())
    .filter(([, bar]) => Number.isFinite(bar.open ?? Number.NaN) && Number.isFinite(bar.close))
    .filter(([date]) => options.startDate == null || date >= options.startDate)
    .filter(([date]) => options.endDate == null || date <= options.endDate)
    .map(([date, bar]) => ({
      date,
      open: bar.open as number,
      close: bar.close,
      source: "yahoo" as const,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function appendProvisionalYahooRows(
  rows: DailyPrice[],
  yahooRows: Array<{ date: string; open: number; close: number }>,
  modernName: "VOO" | "QQQ",
): number {
  const rowDates = new Set(rows.map((row) => row.date));
  let appended = 0;

  for (const yahooRow of yahooRows) {
    if (rowDates.has(yahooRow.date)) continue;
    const prev = rows[rows.length - 1];
    if (
      !prev ||
      prev.adj_close == null ||
      !Number.isFinite(prev.adj_close) ||
      prev.adj_close <= 0 ||
      prev.close == null ||
      !Number.isFinite(prev.close) ||
      prev.close <= 0
    ) {
      continue;
    }
    rows.push({
      date: yahooRow.date,
      adj_close: prev.adj_close * (yahooRow.close / prev.close),
      open: yahooRow.open,
      close: yahooRow.close,
      name: modernName,
      source: "yahoo(open+close)+provisional(adj_close)",
    });
    rowDates.add(yahooRow.date);
    appended++;
  }

  return appended;
}

async function fetchStooqOpenCloseRows(
  symbol: string,
  seriesName: string
): Promise<Array<{ date: string; open: number; close: number }>> {
  const apiKey = process.env.STOOQ_API_KEY;
  if (!apiKey) {
    throw new Error("STOOQ_API_KEY not configured");
  }

  const url = new URL("https://stooq.com/q/d/l/");
  url.searchParams.set("s", symbol);
  url.searchParams.set("i", "d");
  url.searchParams.set("apikey", apiKey);

  const response = await withRetry(
    () => fetch(url.toString(), { signal: AbortSignal.timeout(30000) }),
    3,
    1000
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Stooq API error (${response.status}) for ${seriesName}: ${body.slice(0, 200)}`);
  }

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error(`Stooq returned no rows for ${seriesName}`);
  }

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const openIdx = header.indexOf("open");
  const closeIdx = header.indexOf("close");
  if (dateIdx === -1 || openIdx === -1 || closeIdx === -1) {
    throw new Error(`Stooq response missing Date/Open/Close columns for ${seriesName}: ${csv.slice(0, 200)}`);
  }

  const rows: Array<{ date: string; open: number; close: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = (cols[dateIdx] ?? "").trim();
    const open = Number(cols[openIdx]);
    const close = Number(cols[closeIdx]);
    if (!date || !isFinite(open) || !isFinite(close) || open <= 0 || close <= 0) continue;
    rows.push({ date, open, close });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    throw new Error(`Stooq returned no valid Date/Open/Close rows for ${seriesName}`);
  }

  return rows;
}


function parseOptionalNumber(val: string | undefined): number | undefined {
  if (val === undefined || val === "") return undefined;
  const num = Number(val);
  return isFinite(num) ? num : undefined;
}

/** ISO YYYY-MM-DD calendar arithmetic (UTC). */
function addCalendarDaysIso(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function minIsoDate(a: string, b: string): string {
  return a < b ? a : b;
}

function maxIsoDate(...dates: Array<string | undefined | null>): string | null {
  let max: string | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (max === null || date > max) {
      max = date;
    }
  }
  return max;
}

function normalizeFredObservationStart(date: string): string {
  return date.length === 7 ? `${date}-01` : date;
}

/**
 * Tiingo start date for incremental index merges. Must overlap prior calendar days
 * so rows that already have SPX/NDX `close` (e.g. from Yahoo) still receive fresh
 * Tiingo adj_open/adj_close when the CSV tail is only a Yahoo-only day (fetching
 * from that day alone would skip the previous row).
 */
function indexIncrementalTiingoFetchStart(lastDate: string, earliestPartialTailDate: string | undefined): string {
  const overlapLookback = addCalendarDaysIso(lastDate, -21);
  const maxLookbackFloor = addCalendarDaysIso(lastDate, -60);
  const partialOrLast = earliestPartialTailDate ?? lastDate;
  let start = minIsoDate(partialOrLast, overlapLookback);
  if (start < maxLookbackFloor) start = maxLookbackFloor;
  return start;
}

function parseIndexCsvRows(rows: string[][]): DailyPrice[] {
  return rows.map((row) => {
    return {
      date: row[0],
      adj_close: parseOptionalNumber(row[1]),
      open: parseOptionalNumber(row[2]),
      close: parseOptionalNumber(row[3]),
      name: row[4] ?? "",
      source: row[5] ?? "",
    };
  });
}

/**
 * `close` is fetched-directly when the source tag identifies a vendor (stooq,
 * fred, yahoo, tiingo) without scaling math. When the tag includes "scaled"
 * (e.g. `scaled(close)+...` for pre-FRED NDX, or `tiingo+ratio-scaled-close`
 * for QQQ days FRED/Yahoo missed) the close was synthesized from a ratio and
 * should round to 6 sig digits like other calculated cells.
 */
function isCloseFetchedDirect(source: string): boolean {
  return !source.includes("scaled");
}

function serializeIndexCsvRow(row: DailyPrice): string[] {
  const adjCloseStr = fmt6(row.adj_close);
  // Emit raw `open` whenever we have a positive value (including open === close).
  const openStr =
    row.open != null && Number.isFinite(row.open) && row.open > 0 ? fmt6(row.open) : "";
  const closeStr = isCloseFetchedDirect(row.source) ? fmtRaw(row.close) : fmt6(row.close);
  return [row.date, adjCloseStr, openStr, closeStr, row.name, row.source];
}

function getTrailingIndexRowsMissingAdjustedData(rows: DailyPrice[]): DailyPrice[] {
  const trailing: DailyPrice[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const hasAdjClose = isFinite(row.adj_close ?? Number.NaN) && (row.adj_close ?? 0) > 0;
    if (!hasAdjClose) {
      trailing.unshift(row);
    } else {
      break;
    }
  }
  return trailing;
}

async function fetchFredSeries(
  seriesId: string,
  startDate?: string,
  endDate?: string,
  options?: { carryForwardMissing?: boolean }
): Promise<Array<{ date: string; value: number; carriedForward?: boolean }>> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY not configured");

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  // FRED's API only accepts the key as a query param; it has no header-auth option.
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  if (startDate) url.searchParams.set("observation_start", startDate);
  if (endDate) url.searchParams.set("observation_end", endDate);

  const fetchOnce = async () => {
    const response = await withRetry(
      () => fetch(url.toString(), { signal: AbortSignal.timeout(15000) }),
      3,
      500
    );

    if (response.ok) {
      return response;
    }

    if (response.status === 500) {
      return null;
    }

    throw new Error(`FRED API error (${response.status}) for ${seriesId}`);
  };

  let response = await fetchOnce();
  if (!response) {
    console.warn(`  ! FRED returned 500 for ${seriesId}; retrying once...`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await fetchOnce();
  }

  if (!response) {
    console.warn(`  ! FRED returned 500 again for ${seriesId}; giving up`);
    throw new Error(`FRED API error (500) for ${seriesId}`);
  }

  const data = (await response.json()) as { observations: Array<{ date: string; value: string }> };
  const rows: Array<{ date: string; value: number; carriedForward?: boolean }> = [];
  let lastValue: number | null = null;
  for (const obs of data.observations ?? []) {
    if (!obs.date) continue;
    const rawValue = obs.value?.trim();
    if (rawValue === ".") {
      if (options?.carryForwardMissing && lastValue !== null) {
        rows.push({ date: obs.date, value: lastValue, carriedForward: true });
      }
      continue;
    }
    const value = parseFloat(rawValue);
    if (!isFinite(value)) continue;
    lastValue = value;
    rows.push({ date: obs.date, value });
  }
  return rows;
}

const GITHUB_CSV_URL = "https://raw.githubusercontent.com/SteelCerberus/us-market-data/main/data/us_market_data.csv";

async function getGithubCsvText(): Promise<string> {
  const response = await withRetry(
    () => fetch(GITHUB_CSV_URL, { signal: AbortSignal.timeout(30000) }),
    3,
    1000
  );

  if (!response.ok) {
    throw new Error(`GitHub CSV returned ${response.status}`);
  }

  return response.text();
}

async function fetchGithubCsvRows(): Promise<Array<{ date: string; close: number; rawClose: number }>> {
  const csv = await getGithubCsvText();
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const adjCloseIdx = header.indexOf("adjusted close");
  const closeIdx = header.indexOf("close");
  const dateIdx = header.indexOf("date");

  const rows: Array<{ date: string; close: number; rawClose: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = (cols[dateIdx] ?? "").trim();
    const adjustedClose = cols[adjCloseIdx];
    const rawClose = cols[closeIdx];
    if (!date || !isFinite(Number(adjustedClose)) || adjustedClose === "") continue;
    const parsedAdjustedClose = parseFloat(adjustedClose);
    const parsedRawClose = isFinite(Number(rawClose)) && rawClose !== "" ? parseFloat(rawClose) : parsedAdjustedClose;
    rows.push({ date, close: parsedAdjustedClose, rawClose: parsedRawClose });
  }
  return rows;
}

async function fetchGithubRateRows(): Promise<Array<{ date: string; value: number }>> {
  const csv = await getGithubCsvText();
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const rateIdx = header.indexOf("risk free rate");
  const swapIdx = header.indexOf("swap rate");

  const rateByMonth = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = (cols[dateIdx] ?? "").trim();
    let rate = cols[rateIdx];

    if (rate === "0" && swapIdx !== -1) {
      rate = cols[swapIdx];
    }

    if (!date || rate === "0" || !isFinite(Number(rate))) continue;
    const monthKey = date.slice(0, 7);
    rateByMonth.set(monthKey, parseFloat(rate) / 100);
  }

  return Array.from(rateByMonth.entries())
    .map(([month, value]) => ({ date: month, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchDatahubGoldRows(): Promise<Array<{ date: string; close: number }>> {
  const DATAHUB_GOLD_URL = "https://r2.datahub.io/cm28xb8e70000mi0dxp9tytnn/main/raw/data/monthly.csv";

  const response = await withRetry(
    () => fetch(DATAHUB_GOLD_URL, { signal: AbortSignal.timeout(30000) }),
    3,
    1000
  );

  if (!response.ok) {
    throw new Error(`Datahub.io returned ${response.status}`);
  }

  const csv = await response.text();

  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const monthlyRows: Array<{ date: string; close: number }> = [];

  // Parse monthly data (format: "YYYY-MM")
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length >= 2) {
      const dateStr = parts[0].trim(); // Format: "YYYY-MM"
      const priceStr = parts[1].trim();
      const price = parseFloat(priceStr);

      // Parse year-month from date string
      const monthMatch = dateStr.match(/^(\d{4})-(\d{2})$/);
      if (!monthMatch || !isFinite(price) || price <= 0) continue;

      const year = parseInt(monthMatch[1]);
      if (year < 1885) continue;

      monthlyRows.push({ date: dateStr, close: price });
    }
  }

  return monthlyRows.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================================
// High-level History Fetchers
// ============================================================================

async function fetchTqqqHistory(): Promise<DailyPrice[]> {
  const rows = await fetchTiingoRows("TQQQ");
  return rows.map(r => ({
    date: r.date,
    adj_close: r.adjClose,
    name: "TQQQ",
    source: "tiingo",
  }));
}

async function fetchUproHistory(): Promise<DailyPrice[]> {
  const rows = await fetchTiingoRows("UPRO");
  return rows.map(r => ({
    date: r.date,
    adj_close: r.adjClose,
    name: "UPRO",
    source: "tiingo",
  }));
}

async function fetchQldHistory(): Promise<DailyPrice[]> {
  const rows = await fetchTiingoRows("QLD");
  return rows.map(r => ({
    date: r.date,
    adj_close: r.adjClose,
    name: "QLD",
    source: "tiingo",
  }));
}

async function fetchSsoHistory(): Promise<DailyPrice[]> {
  const rows = await fetchTiingoRows("SSO");
  return rows.map(r => ({
    date: r.date,
    adj_close: r.adjClose,
    name: "SSO",
    source: "tiingo",
  }));
}

// index-sp.csv uses the Fama-French value-weighted large-cap total return for
// 1926-07-01..1988-04-05 instead of the S&P Composite. Before 1988-04-06 the
// S&P 500 ran under fixed industry-sector quotas, and before 1957-03 it was the
// backfilled 90-stock Composite. See DataFetch.md and scripts/build-ff-index.py.
// Yahoo's `^NDX` only reaches back to 1985-10-01, leaving the 168 sessions from
// the Nasdaq-100's 1985-01-31 launch to be backfilled from the Composite — a
// different basket, off by 0.28%/day at the median across that window. The index
// owner publishes the real closes for free; see scripts/build-ndx-1985.ts and
// DataFetch.md.
const NDX_1985_FILE = "index-ndx-1985.csv";

/**
 * Real NDX closes ahead of Yahoo's coverage, as bars.
 *
 * The source is close-only: its start-of-day series is just the prior close, so
 * no genuine opening print exists for this era. Carrying the prior close forward
 * as the open matches both that and Yahoo's own early `^NDX` rows, whose opens
 * are overwhelmingly the previous close.
 */
async function readNdx1985Bars(): Promise<Array<{ date: string; open: number; close: number; source: "yahoo" }>> {
  const existing = await readExistingCsv(NDX_1985_FILE);
  if (!existing) {
    throw new Error(
      `index-nq: ${NDX_1985_FILE} is missing - regenerate it with "npx tsx scripts/build-ndx-1985.ts"`
    );
  }
  const columns = existing.header.split(",");
  const dateIdx = columns.indexOf("date");
  const closeIdx = columns.indexOf("close");
  if (dateIdx < 0 || closeIdx < 0) {
    throw new Error(`index-nq: ${NDX_1985_FILE} lacks date/close columns`);
  }

  const closes = existing.rows
    .map((cols) => ({ date: cols[dateIdx], close: Number(cols[closeIdx]) }))
    .filter((row) => row.date && Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (closes.length === 0) {
    throw new Error(`index-nq: ${NDX_1985_FILE} has no usable rows`);
  }

  return closes.map((row, i) => ({
    date: row.date,
    open: i === 0 ? row.close : closes[i - 1].close,
    close: row.close,
    source: "yahoo" as const,
  }));
}

const FF_LARGE_CAP_FILE = "index-ffhi30.csv";
const FF_SPLICE_START = CONSTANT_SP500_PROXY_START_DATE;
const FF_SPLICE_END_EXCLUSIVE = "1988-04-06";
const FF_SPLICE_NAME = "FF-HI30-TR";
// Both tags carry "scaled" so serializeIndexCsvRow rounds their derived `close`
// to 6 significant figures instead of emitting raw float noise.
const FF_SPLICE_SOURCE = "famafrench-vw(adj_close)+sp500-divyield-scaled(close)";
const FF_RESCALED_SOURCE = "stooq-scaled(open+close)+github+er(adj_close)";

async function readFfLargeCapRows(): Promise<Array<{ date: string; adj_close: number }>> {
  const existing = await readExistingCsv(FF_LARGE_CAP_FILE);
  if (!existing) {
    throw new Error(
      `index-sp: ${FF_LARGE_CAP_FILE} is missing - regenerate it with "python3 scripts/build-ff-index.py"`
    );
  }
  const columns = existing.header.split(",");
  const dateIdx = columns.indexOf("date");
  const adjIdx = columns.indexOf("adj_close");
  if (dateIdx < 0 || adjIdx < 0) {
    throw new Error(`index-sp: ${FF_LARGE_CAP_FILE} lacks date/adj_close columns`);
  }

  const rows = existing.rows
    .map((cols) => ({ date: cols[dateIdx], adj_close: Number(cols[adjIdx]) }))
    .filter((row) => row.date && Number.isFinite(row.adj_close) && row.adj_close > 0);
  if (rows.length === 0) {
    throw new Error(`index-sp: ${FF_LARGE_CAP_FILE} has no usable rows`);
  }
  return rows;
}

async function fetchIndexSpHistory(): Promise<DailyPrice[]> {
  const vooRows = await fetchTiingoRows("VOO");

  if (vooRows.length === 0) {
    throw new Error("No VOO data available from Tiingo");
  }

  const stooqSpRows = await fetchStooqOpenCloseRows("^spx", "S&P 500");
  const yahooRows = await fetchYahooIndexBars("^GSPC", { fullHistory: true });
  if (yahooRows.length === 0) {
    throw new Error("No Yahoo ^GSPC open/close data available");
  }
  const githubRows = await fetchGithubCsvRows();

  const rawStitchedRows = stitchBoundary(
    vooRows,
    githubRows,
    "VOO",
    "tiingo",
    "SP500-TR",
    "github-csv"
  );
  const stitchedRows = applyPreInceptionExpenseDrag(
    rawStitchedRows,
    vooRows[0].date,
    EQUITY_PROXY_EXPENSE_RATIOS.VOO
  );

  const yahooByDate = new Map(yahooRows.map((row) => [row.date, row]));
  const firstYahooDate = yahooRows[0].date;
  const stooqByDate = new Map(stooqSpRows.map((row) => [row.date, row]));

  let stooqCursor = -1;
  const result = stitchedRows.map((row) => {
    while (stooqCursor + 1 < stooqSpRows.length && stooqSpRows[stooqCursor + 1].date <= row.date) {
      stooqCursor++;
    }
    const yahoo = yahooByDate.get(row.date);
    const stooq = stooqByDate.get(row.date);
    const stooqCarry = row.date < firstYahooDate && stooqCursor >= 0 ? stooqSpRows[stooqCursor] : undefined;
    const raw = yahoo ?? stooq ?? (stooqCarry ? { date: row.date, open: stooqCarry.close, close: stooqCarry.close } : undefined);
    if (!raw) {
      throw new Error(`index-sp: missing Yahoo/Stooq open/close for ${row.date}`);
    }
    const rawSource = yahoo ? "yahoo(open+close)" : stooq ? "stooq(open+close)" : "stooq-carry(open+close)";
    const adjustedSource = row.name === "VOO" ? "tiingo(adj_close)" : "github+er(adj_close)";
    return {
      date: row.date,
      adj_close: row.adj_close,
      open: raw.open,
      close: raw.close,
      name: row.name,
      source: `${rawSource}+${adjustedSource}`,
    };
  });

  appendProvisionalYahooRows(result, yahooRows, "VOO");

  const spliced = spliceFfLargeCapHistory({
    rows: result,
    ffRows: await readFfLargeCapRows(),
    spliceStart: FF_SPLICE_START,
    spliceEndExclusive: FF_SPLICE_END_EXCLUSIVE,
    name: FF_SPLICE_NAME,
    source: FF_SPLICE_SOURCE,
    rescaledSource: FF_RESCALED_SOURCE,
  });
  console.log(
    `  ✓ index-sp: spliced ${spliced.replacedCount} Fama-French large-cap rows ` +
      `(${FF_SPLICE_START}..${FF_SPLICE_END_EXCLUSIVE}), rescaled ${spliced.rescaledCount} earlier rows`
  );
  return spliced.rows;
}

async function fetchIndexNqHistory(): Promise<DailyPrice[]> {
  const qqqRows = await fetchTiingoRows("QQQ");

  if (qqqRows.length === 0) {
    throw new Error("No QQQ data available from Tiingo");
  }

  const ixicRows = await fetchYahooIndexBars("^IXIC", { fullHistory: true });
  const yahooNdxRows = await fetchYahooIndexBars("^NDX", { fullHistory: true });
  if (ixicRows.length === 0) {
    throw new Error("No Yahoo ^IXIC open/close data available");
  }
  if (yahooNdxRows.length === 0) {
    throw new Error("No Yahoo ^NDX open/close data available");
  }

  // Front the vendor series with the index owner's own history. Both are on the
  // same scale (they agree to a rounding cent over the Oct-Dec 1985 overlap), so
  // this needs no re-anchoring — and because everything downstream keys off
  // `ndxFirstDate`, moving that back to the launch is all the splice has to do.
  const yahooNdxFirstDate = yahooNdxRows[0].date;
  const ndxHistoricalRows = (await readNdx1985Bars()).filter((row) => row.date < yahooNdxFirstDate);
  const ndxRows = [...ndxHistoricalRows, ...yahooNdxRows];

  const ixicByDate = new Map(ixicRows.map((row) => [row.date, row]));
  const ndxByDate = new Map(ndxRows.map((row) => [row.date, row]));
  const ndxFirstDate = ndxRows[0].date;
  const qqqFirstDate = qqqRows[0].date;

  const qqqDailyER = EQUITY_PROXY_EXPENSE_RATIOS.QQQ / TRADING_DAYS_PER_YEAR;
  const syntheticRows: Array<{ date: string; adjClose: number; name: "NDQ-TR" | "NDX-TR" }> = [];
  let syntheticTr = 100;

  for (let i = 0; i < ixicRows.length && ixicRows[i].date < ndxFirstDate; i++) {
    const row = ixicRows[i];
    if (i > 0) {
      const prev = ixicRows[i - 1];
      const year = Number(row.date.slice(0, 4));
      const divYield = NASDAQ_COMPOSITE_DIVIDEND_YIELD[year] ?? 0.025;
      const priceReturn = row.close / prev.close - 1;
      syntheticTr *= 1 + priceReturn + divYield / TRADING_DAYS_PER_YEAR - qqqDailyER;
    }
    syntheticRows.push({ date: row.date, adjClose: syntheticTr, name: "NDQ-TR" });
  }

  const ndxFirstIxic = ixicByDate.get(ndxFirstDate);
  const prevIxic = ixicRows.filter((row) => row.date < ndxFirstDate).at(-1);
  if (!ndxFirstIxic || !prevIxic) {
    throw new Error(`index-nq: missing Yahoo ^IXIC boundary data for ${ndxFirstDate}`);
  }
  const ndxFirstRaw = ndxByDate.get(ndxFirstDate);
  if (!ndxFirstRaw) {
    throw new Error(`index-nq: missing Yahoo ^NDX boundary data for ${ndxFirstDate}`);
  }
  const ixicToNdxScale = ndxFirstRaw.close / ndxFirstIxic.close;

  const boundaryYear = Number(ndxFirstDate.slice(0, 4));
  const boundaryDivYield = NASDAQ100_DIVIDEND_YIELD[boundaryYear] ?? 0.012;
  syntheticTr *= 1 + (ndxFirstIxic.close / prevIxic.close - 1) + boundaryDivYield / TRADING_DAYS_PER_YEAR - qqqDailyER;
  syntheticRows.push({ date: ndxFirstDate, adjClose: syntheticTr, name: "NDX-TR" });

  for (let i = 1; i < ndxRows.length && ndxRows[i].date <= qqqFirstDate; i++) {
    const row = ndxRows[i];
    const prev = ndxRows[i - 1];
    const year = Number(row.date.slice(0, 4));
    const divYield = NASDAQ100_DIVIDEND_YIELD[year] ?? 0.001;
    const priceReturn = row.close / prev.close - 1;
    syntheticTr *= 1 + priceReturn + divYield / TRADING_DAYS_PER_YEAR - qqqDailyER;
    syntheticRows.push({ date: row.date, adjClose: syntheticTr, name: "NDX-TR" });
  }

  const qqqAnchor = qqqRows[0];
  const syntheticAnchor = syntheticRows.find((row) => row.date === qqqFirstDate);
  if (!syntheticAnchor) {
    throw new Error(`No synthetic NDX-TR data available for ${qqqFirstDate}`);
  }
  const scaleToQqq = qqqAnchor.adjClose / syntheticAnchor.adjClose;
  const result: DailyPrice[] = [];

  for (const synthetic of syntheticRows) {
    if (synthetic.date >= qqqFirstDate) continue;
    const raw = synthetic.date < ndxFirstDate ? ixicByDate.get(synthetic.date) : ndxByDate.get(synthetic.date);
    if (!raw) {
      throw new Error(`index-nq: missing Yahoo raw open/close for ${synthetic.date}`);
    }
    const rawScale = synthetic.date < ndxFirstDate ? ixicToNdxScale : 1;
    result.push({
      date: synthetic.date,
      adj_close: synthetic.adjClose * scaleToQqq,
      open: raw.open * rawScale,
      close: raw.close * rawScale,
      name: synthetic.name,
      source: synthetic.name === "NDQ-TR"
        ? "yahoo-ixic-scaled(open+close)+dividends+er(adj_close)"
        : synthetic.date < yahooNdxFirstDate
          ? "nasdaq-giw(close)+carried(open)+dividends+er(adj_close)"
          : "yahoo-ndx(open+close)+dividends+er(adj_close)",
    });
  }

  for (const row of qqqRows) {
    const yahoo = ndxByDate.get(row.date);
    if (!yahoo) {
      throw new Error(`index-nq: missing Yahoo ^NDX open/close for ${row.date}`);
    }
    result.push({
      date: row.date,
      adj_close: row.adjClose,
      close: yahoo.close,
      open: yahoo.open,
      name: "QQQ",
      source: "yahoo(open+close)+tiingo(adj_close)",
    });
  }

  appendProvisionalYahooRows(result, yahooNdxRows, "QQQ");
  return result;
}

async function fetchBrkaHistory(): Promise<DailyPrice[]> {
  const brkaRows = await fetchTiingoRows("BRK-A");

  if (brkaRows.length === 0) {
    throw new Error("No BRK-A data available from Tiingo");
  }

  // Pre-BRK-A proxy: 50% VGSH (1-3Y Treasury) + 50% S&P 500 total return.
  const sp500Rows = await fetchIndexSpHistory();
  const vgshRows = await fetchVgshHistory();
  const brkaFirstDate = brkaRows[0].date;

  // Build a daily log-interpolated VGSH close map so it aligns with S&P trading days
  // (VGSH pre-inception series is monthly before ~2009-10).
  const vgshSorted = vgshRows
    .filter((r) => r.adj_close != null && isFinite(r.adj_close))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const vgshLogPriceByDate = new Map<string, number>();
  for (const r of vgshSorted) vgshLogPriceByDate.set(r.date, Math.log(r.adj_close as number));

  const interpolateVgshLogPrice = (targetDate: string): number | null => {
    if (vgshSorted.length === 0) return null;
    const exact = vgshLogPriceByDate.get(targetDate);
    if (exact != null) return exact;
    // Binary search for bracketing entries
    let lo = 0;
    let hi = vgshSorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vgshSorted[mid].date < targetDate) lo = mid + 1;
      else hi = mid;
    }
    const rightIdx = lo;
    const leftIdx = rightIdx - 1;
    if (leftIdx < 0) return vgshLogPriceByDate.get(vgshSorted[rightIdx].date) ?? null;
    if (rightIdx >= vgshSorted.length) return vgshLogPriceByDate.get(vgshSorted[leftIdx].date) ?? null;
    const left = vgshSorted[leftIdx];
    const right = vgshSorted[rightIdx];
    const leftLog = vgshLogPriceByDate.get(left.date);
    const rightLog = vgshLogPriceByDate.get(right.date);
    if (leftLog == null || rightLog == null) return null;
    const leftTime = new Date(left.date + "T00:00:00Z").getTime();
    const rightTime = new Date(right.date + "T00:00:00Z").getTime();
    const targetTime = new Date(targetDate + "T00:00:00Z").getTime();
    const span = rightTime - leftTime;
    if (span <= 0) return leftLog;
    const frac = (targetTime - leftTime) / span;
    return leftLog + (rightLog - leftLog) * frac;
  };

  // Build daily 50/50 blended synthetic series over S&P trading days up to (but not
  // including) BRK-A inception. Each step compounds 0.5*spRet + 0.5*vgshRet.
  const spPreBrk = sp500Rows
    .filter((r) => r.date < brkaFirstDate && r.adj_close != null && isFinite(r.adj_close))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (spPreBrk.length < 2) {
    throw new Error("Not enough pre-BRK S&P 500 data to build blended proxy");
  }

  const blendedRows: Array<{ date: string; close: number }> = [];
  let blendedPrice = 100;
  blendedRows.push({ date: spPreBrk[0].date, close: blendedPrice });
  let prevVgshLog = interpolateVgshLogPrice(spPreBrk[0].date);
  for (let i = 1; i < spPreBrk.length; i++) {
    const prev = spPreBrk[i - 1];
    const curr = spPreBrk[i];
    const spRet = (curr.adj_close as number) / (prev.adj_close as number) - 1;
    const currVgshLog = interpolateVgshLogPrice(curr.date);
    const vgshRet =
      prevVgshLog != null && currVgshLog != null
        ? Math.exp(currVgshLog - prevVgshLog) - 1
        : 0;
    const blendedRet = 0.5 * spRet + 0.5 * vgshRet;
    blendedPrice = blendedPrice * (1 + blendedRet);
    blendedRows.push({ date: curr.date, close: blendedPrice });
    prevVgshLog = currVgshLog;
  }

  // Also include the BRK-A inception date in the blended series so stitchBoundary
  // can scale the synthetic anchor to match the real BRK-A first price.
  const spOnBrkFirst = sp500Rows.find((r) => r.date === brkaFirstDate);
  const vgshOnBrkFirst = interpolateVgshLogPrice(brkaFirstDate);
  if (spOnBrkFirst && spOnBrkFirst.adj_close != null) {
    const lastSp = spPreBrk[spPreBrk.length - 1];
    const spRet = (spOnBrkFirst.adj_close as number) / (lastSp.adj_close as number) - 1;
    const vgshRet =
      prevVgshLog != null && vgshOnBrkFirst != null
        ? Math.exp(vgshOnBrkFirst - prevVgshLog) - 1
        : 0;
    blendedPrice = blendedPrice * (1 + 0.5 * spRet + 0.5 * vgshRet);
    blendedRows.push({ date: brkaFirstDate, close: blendedPrice });
  }

  return stitchBoundary(
    brkaRows,
    blendedRows,
    "BRK-A",
    "tiingo",
    "SP500+VGSH(50/50)",
    "synthetic"
  );
}

async function fetchGldmHistory(): Promise<DailyPrice[]> {
  const gldmRows = await fetchTiingoRows("GLDM");

  if (gldmRows.length === 0) {
    throw new Error("No GLDM data available from Tiingo");
  }

  // Fetch Datahub gold data for pre-GLDM period
  const datahubGoldRows = await fetchDatahubGoldRows();
  // Filter Datahub to include the month of GLDM inception for scaling, then exclude it from output
  const firstGldmDate = gldmRows[0].date;
  const firstGldmMonth = firstGldmDate.slice(0, 7); // "2018-06"
  const historicalGoldRows = datahubGoldRows.filter(r => r.date <= firstGldmMonth);

  if (historicalGoldRows.length > 0) {
    // Find Datahub row on GLDM's first month for scaling (overlap date)
    const datahubOnGldmMonth = historicalGoldRows.find(r => r.date === firstGldmMonth);
    
    if (!datahubOnGldmMonth) {
      throw new Error(`No Datahub gold data available for ${firstGldmMonth}`);
    }

    // Filter to strictly before GLDM's first month for output
    const historicalGoldPreGldm = historicalGoldRows.filter(r => r.date < firstGldmMonth);

    if (historicalGoldPreGldm.length === 0) {
      throw new Error("No Datahub gold data available before GLDM inception");
    }

    // Build ER-adjusted price series from datahub gold, including the overlap month.
    // Then scale the entire series so the overlap month matches GLDM's first price.
    const gldmMonthlyER = RISK_OFF_EXPENSE_RATIOS.GLDM / 12;

    // Build forward from arbitrary start, applying ER-adjusted returns
    const tempPrices: number[] = [100];
    for (let i = 1; i < historicalGoldRows.length; i++) {
      const rawReturn = historicalGoldRows[i].close / historicalGoldRows[i - 1].close - 1;
      tempPrices.push(tempPrices[i - 1] * (1 + rawReturn - gldmMonthlyER));
    }

    // Scale so the overlap month (last element) matches GLDM's first price
    const overlapIdx = historicalGoldRows.findIndex(r => r.date === firstGldmMonth);
    const scaleToGldm = gldmRows[0].adjClose / tempPrices[overlapIdx];

    const datahubPrices: DailyPrice[] = historicalGoldRows
      .filter(r => r.date < firstGldmMonth)
      .map((r, i) => ({
        date: r.date,
        adj_close: tempPrices[i] * scaleToGldm,
        name: "XAU/USD",
        source: "datahub-io+er",
      }));

    const gldmPrices = gldmRows.map(r => ({
      date: r.date,
      adj_open: r.adjOpen,
      adj_close: r.adjClose,
      name: "GLDM",
      source: "tiingo",
    }));

    return [...datahubPrices, ...gldmPrices];
  }

  // Fallback: just GLDM if no Datahub data available
  return gldmRows.map(r => ({
    date: r.date,
    adj_open: r.adjOpen,
    adj_close: r.adjClose,
    name: "GLDM",
    source: "tiingo",
  }));
}

async function fetchVgshHistory(): Promise<DailyPrice[]> {
  const vgshRows = await fetchTiingoRows("VGSH");

  if (vgshRows.length === 0) {
    throw new Error("No VGSH data available from Tiingo");
  }

  // Prepend VGSH with SHY (1-3Y Treasury, launched 2002-07-22) for the
  // pre-VGSH period, mirroring how NDX is prepended with NDQ.
  // SHY is scaled so its price on VGSH's first trading day matches VGSH's
  // first price; this preserves SHY's daily returns while aligning levels
  // (the boundary's daily change is SHY's own return on that day).
  const shyRows = await fetchTiingoRows("SHY");

  if (shyRows.length === 0) {
    throw new Error("No SHY data available from Tiingo");
  }

  const vgshFirstDate = vgshRows[0].date;
  const vgshFirstPrice = vgshRows[0].adjClose;

  const shyOnVgshFirst = shyRows.find((r) => r.date === vgshFirstDate);
  if (!shyOnVgshFirst) {
    throw new Error(`No SHY data on VGSH boundary date ${vgshFirstDate}`);
  }
  const shyToVgshScale = vgshFirstPrice / shyOnVgshFirst.adjClose;

  // The rate-based proxy is now pinned to SHY's first date (instead of
  // VGSH's), so the proxy chains: rates → SHY → VGSH.
  const proxyAnchorDate = shyRows[0].date;
  const proxyAnchorMonth = proxyAnchorDate.slice(0, 7);
  const proxyAnchorPrice = shyRows[0].adjClose * shyToVgshScale;

  const githubRateRows = await fetchGithubRateRows();
  const fredRows = await fetchFredSeries("DGS2");

  const rateMap = new Map<string, number>();
  for (const row of githubRateRows) {
    if (row.date < proxyAnchorMonth) {
      rateMap.set(row.date, row.value);
    }
  }
  for (const row of fredRows) {
    const monthKey = row.date.slice(0, 7);
    if (monthKey < proxyAnchorMonth) {
      rateMap.set(monthKey, row.value / 100);
    }
  }

  const rateRows = Array.from(rateMap.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // WORK-BACKWARDS STITCHING:
  // Start from SHY's (scaled) first price and work backwards through rate data
  // This ensures the boundary has proper return continuity

  const lastRateRow = rateRows[rateRows.length - 1];
  const lastRateDate = lastRateRow?.date;
  const lastRateYield = lastRateRow?.value ?? 0;

  if (!lastRateDate) {
    throw new Error("No rate data available for VGSH proxy");
  }

  // Calculate the gap between last rate date and proxy anchor (SHY first date).
  const lastRateTime = new Date(lastRateDate + "T00:00:00Z").getTime();
  const proxyAnchorTime = new Date(proxyAnchorDate + "T00:00:00Z").getTime();
  const gapDays = Math.max(1, Math.floor((proxyAnchorTime - lastRateTime) / (1000 * 60 * 60 * 24)));

  // For the gap period, estimate daily return using the last known yield
  // We use a simplified model: daily return ≈ (yield / 12) / 30 (yield income only, no duration effect)
  // This is reasonable for short gaps where yield changes are unknown
  const dailyYieldIncome = (lastRateYield / 12) / 30;

  // Work backwards from the proxy anchor price to estimate price at last rate date
  const priceAtLastRateDate = proxyAnchorPrice / Math.pow(1 + dailyYieldIncome, gapDays);

  // Now build the full historical price series using treasuryYieldToPriceSeries logic
  // but scaled so the last rate date matches our calculated priceAtLastRateDate

  // First, generate forward price series from rates (standard approach)
  const vgshMonthlyER = RISK_OFF_EXPENSE_RATIOS.VGSH / 12;
  const vgshDailyER = RISK_OFF_EXPENSE_RATIOS.VGSH / 365.25;

  const tempPriceSeries: DailyPrice[] = [];
  let tempPrice = 100;
  let prevYield = rateRows[0]?.value ?? 0;
  const duration = 2; // 2-year treasury duration

  for (let i = 0; i < rateRows.length; i++) {
    const annualYield = rateRows[i].value;
    if (i > 0) {
      const yieldIncome = prevYield / 12;
      const yieldChange = annualYield - prevYield;
      const priceChange = -duration * yieldChange;
      const monthlyReturn = yieldIncome + priceChange - vgshMonthlyER;
      tempPrice = tempPrice * (1 + monthlyReturn);
    }
    tempPriceSeries.push({
      date: rateRows[i].date,
      adj_close: tempPrice,
      name: "DGS2",
      source: "github-csv+er",
    });
    prevYield = annualYield;
  }

  // Scale so last price matches calculated priceAtLastRateDate
  const lastTempPrice = tempPriceSeries[tempPriceSeries.length - 1].adj_close as number;
  const scale = priceAtLastRateDate / lastTempPrice;

  const historicalPrices: DailyPrice[] = tempPriceSeries.map(row => ({
    date: row.date,
    adj_close: (row.adj_close as number) * scale,
    name: row.name,
    source: row.source,
  }));

  // Generate daily gap-fill prices from last rate date to SHY first date
  const gapPrices: DailyPrice[] = [];
  let gapDate = new Date(lastRateDate + "T00:00:00Z");
  let gapPrice = priceAtLastRateDate;

  const proxyAnchorDateObj = new Date(proxyAnchorDate + "T00:00:00Z");
  while (gapDate < proxyAnchorDateObj) {
    gapDate = new Date(gapDate.getTime() + 24 * 60 * 60 * 1000);
    if (gapDate < proxyAnchorDateObj) {
      gapPrice = gapPrice * (1 + dailyYieldIncome - vgshDailyER);
      gapPrices.push({
        date: gapDate.toISOString().slice(0, 10),
        adj_close: gapPrice,
        name: "DGS2",
        source: "github-csv-extended+er",
      });
    }
  }

  // SHY rows from SHY inception up to (but not including) VGSH inception,
  // scaled so SHY[vgshFirstDate] == VGSH[vgshFirstDate].
  const shyPrePrices: DailyPrice[] = shyRows
    .filter((r) => r.date < vgshFirstDate)
    .map((r) => ({
      date: r.date,
      adj_open: r.adjOpen * shyToVgshScale,
      adj_close: r.adjClose * shyToVgshScale,
      name: "SHY",
      source: "tiingo",
    }));

  // Combine: rate proxy + gap fillers + scaled SHY + VGSH daily
  const vgshPrices = vgshRows.map(r => ({
    date: r.date,
    adj_open: r.adjOpen,
    adj_close: r.adjClose,
    name: "VGSH",
    source: "tiingo",
  }));

  return [...historicalPrices, ...gapPrices, ...shyPrePrices, ...vgshPrices];
}

async function fetchSgovHistory(): Promise<DailyPrice[]> {
  const sgovRows = await fetchTiingoRows("SGOV");

  if (sgovRows.length === 0) {
    throw new Error("No SGOV data available from Tiingo");
  }

  const sgovFirstDate = sgovRows[0].date;
  const sgovFirstMonth = sgovFirstDate.slice(0, 7);
  const sgovFirstPrice = sgovRows[0].adjClose;

  const githubRateRows = await fetchGithubRateRows();
  const fredRows = await fetchFredSeries("TB3MS");

  const rateMap = new Map<string, number>();
  for (const row of githubRateRows) {
    if (row.date < sgovFirstMonth) {
      rateMap.set(row.date, row.value);
    }
  }
  for (const row of fredRows) {
    const monthKey = row.date.slice(0, 7);
    if (monthKey < sgovFirstMonth) {
      rateMap.set(monthKey, row.value / 100);
    }
  }

  const rateRows = Array.from(rateMap.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // WORK-BACKWARDS STITCHING (same as VGSH):
  // Start from SGOV's first price and work backwards through rate data

  const lastRateRow = rateRows[rateRows.length - 1];
  const lastRateDate = lastRateRow?.date;
  const lastRateYield = lastRateRow?.value ?? 0;

  if (!lastRateDate) {
    throw new Error("No rate data available for SGOV proxy");
  }

  // Calculate gap between last rate date and SGOV first date
  const lastRateTime = new Date(lastRateDate + "T00:00:00Z").getTime();
  const sgovFirstTime = new Date(sgovFirstDate + "T00:00:00Z").getTime();
  const gapDays = Math.max(1, Math.floor((sgovFirstTime - lastRateTime) / (1000 * 60 * 60 * 24)));

  // Daily yield income for gap period
  const dailyYieldIncome = (lastRateYield / 12) / 30;

  // Work backwards from SGOV's first price
  const priceAtLastRateDate = sgovFirstPrice / Math.pow(1 + dailyYieldIncome, gapDays);

  // Generate price series from rates using yieldToPriceSeries logic
  const sgovMonthlyER = RISK_OFF_EXPENSE_RATIOS.SGOV / 12;
  const sgovDailyER = RISK_OFF_EXPENSE_RATIOS.SGOV / 365.25;

  const tempPriceSeries: DailyPrice[] = [];
  let tempPrice = 100;

  for (let i = 0; i < rateRows.length; i++) {
    const annualYield = rateRows[i].value;
    if (i > 0) {
      const monthlyReturn = annualYield / 12 - sgovMonthlyER;
      tempPrice = tempPrice * (1 + monthlyReturn);
    }
    tempPriceSeries.push({
      date: rateRows[i].date,
      adj_close: tempPrice,
      name: "TB3MS",
      source: "github-csv+er",
    });
  }

  // Scale so last price matches calculated priceAtLastRateDate
  const lastTempPrice = tempPriceSeries[tempPriceSeries.length - 1].adj_close as number;
  const scale = priceAtLastRateDate / lastTempPrice;

  const historicalPrices: DailyPrice[] = tempPriceSeries.map(row => ({
    date: row.date,
    adj_close: (row.adj_close as number) * scale,
    name: row.name,
    source: row.source,
  }));

  // Generate daily gap-fill prices
  const gapPrices: DailyPrice[] = [];
  let gapDate = new Date(lastRateDate + "T00:00:00Z");
  let gapPrice = priceAtLastRateDate;

  const sgovFirstDateObj = new Date(sgovFirstDate + "T00:00:00Z");
  while (gapDate < sgovFirstDateObj) {
    gapDate = new Date(gapDate.getTime() + 24 * 60 * 60 * 1000);
    if (gapDate < sgovFirstDateObj) {
      gapPrice = gapPrice * (1 + dailyYieldIncome - sgovDailyER);
      gapPrices.push({
        date: gapDate.toISOString().slice(0, 10),
        adj_close: gapPrice,
        name: "TB3MS",
        source: "github-csv-extended+er",
      });
    }
  }

  const sgovPrices = sgovRows.map(r => ({
    date: r.date,
    adj_open: r.adjOpen,
    adj_close: r.adjClose,
    name: "SGOV",
    source: "tiingo",
  }));

  return [...historicalPrices, ...gapPrices, ...sgovPrices];
}

async function fetchInflationHistory(tailDate?: string): Promise<Array<{ date: string; value: number; name: string; source: string }>> {
  const preFredCpiByMonth = new Map<string, number>();
  const githubCpiByMonth = new Map<string, number>();
  let latestPreFredGithubDate: string | null = null;

  try {
    const csv = await getGithubCsvText();
    const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const dateIdx = header.indexOf("date");
    const cpiIdx = header.indexOf("cpi");

    if (cpiIdx !== -1) {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const date = (cols[dateIdx] ?? "").trim();
        const cpi = cols[cpiIdx];
        if (!date || !isFinite(Number(cpi)) || cpi === "0" || !cpi) continue;
        const monthKey = date.slice(0, 7);
        githubCpiByMonth.set(monthKey, parseFloat(cpi));
        if (date < "1947-01-01") {
          preFredCpiByMonth.set(monthKey, parseFloat(cpi));
          if (!latestPreFredGithubDate || date > latestPreFredGithubDate) {
            latestPreFredGithubDate = date;
          }
        }
      }
    }
  } catch (err) {
    console.warn("GitHub CSV unavailable for inflation history:", err instanceof Error ? err.message : err);
  }

  const rows: Array<{ date: string; value: number; name: string; source: string }> = [];

  for (const [month, value] of preFredCpiByMonth.entries()) {
    rows.push({ date: month, value, name: "CPI", source: "github-csv" });
  }

  const fredStartDate = maxIsoDate(tailDate, latestPreFredGithubDate);
  const fredRows = await fetchFredSeries(
    "CPIAUCSL",
    fredStartDate ? normalizeFredObservationStart(fredStartDate) : undefined,
    undefined,
    { carryForwardMissing: true }
  );
  const fredMonths = new Set<string>();
  for (const row of fredRows) {
    const monthKey = row.date.slice(0, 7);
    fredMonths.add(monthKey);
    rows.push({
      date: monthKey,
      value: row.value,
      name: "CPIAUCSL",
      source: row.carriedForward ? "fred-carry-forward" : "fred",
    });
  }

  // FRED can publish a placeholder "." for an otherwise known month; fill only
  // those missing modern months from the cached market-data CPI column.
  for (const [month, value] of githubCpiByMonth.entries()) {
    if (month < "1947-01") continue;
    if (fredMonths.has(month)) continue;
    rows.push({ date: month, value, name: "CPI", source: "github-csv-fred-gap" });
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchRateHistory(rateType: string, tailDate?: string): Promise<Array<{ date: string; value: number; name: string; source: string }>> {
  const rateByDate = new Map<string, { value: number; name: string; source: string }>();

  if (rateType === "borrow") {
    let latestGithubDate: string | null = null;
    try {
      const csv = await getGithubCsvText();
      const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
      const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const dateIdx = header.indexOf("date");
      const swapIdx = header.indexOf("swap rate");

      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        const date = (cols[dateIdx] ?? "").trim();
        const rate = cols[swapIdx];
        if (!date || date >= "2018-04-03" || !isFinite(Number(rate)) || rate === "0") continue;
        rateByDate.set(date, { value: parseFloat(rate) / 100, name: "SWAP", source: "github-csv" });
        if (!latestGithubDate || date > latestGithubDate) {
          latestGithubDate = date;
        }
      }
    } catch (err) {
      console.warn("GitHub CSV unavailable for borrow rate history:", err instanceof Error ? err.message : err);
    }

    const fredStartDate = maxIsoDate(tailDate, latestGithubDate);
    const fredRows = await fetchFredSeries("SOFR", fredStartDate ?? undefined);
    for (const row of fredRows) {
      rateByDate.set(row.date, { value: row.value / 100, name: "SOFR", source: "fred" });
    }
  } else {
    throw new Error(`Unknown rate type "${rateType}". Available: borrow`);
  }

  return Array.from(rateByDate.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchIndexSpRecentRows(startDate: string): Promise<DailyPrice[]> {
  const vooRows = await fetchTiingoRows("VOO", startDate);
  if (vooRows.length === 0) return [];

  const yahooRows = await fetchYahooIndexBars("^GSPC", { startDate });
  const merged = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: vooRows,
    rawBars: yahooRows,
    name: "VOO",
    source: "yahoo(open+close)+tiingo(adj_close)",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  if (merged.missingRawDates.length > 0) {
    console.warn(
      `  ! index-sp retained ${merged.missingRawDates.length} Tiingo adjusted-only row(s) without matching Yahoo ^GSPC bars: ${merged.missingRawDates.join(", ")}`
    );
  }

  return merged.rows;
}

async function fetchIndexNqRecentRows(startDate: string): Promise<DailyPrice[]> {
  const qqqRows = await fetchTiingoRows("QQQ", startDate);
  if (qqqRows.length === 0) return [];

  const yahooRows = await fetchYahooIndexBars("^NDX", { startDate });
  const merged = mergeAdjustedPricesWithRawIndexBars({
    adjustedRows: qqqRows,
    rawBars: yahooRows,
    name: "QQQ",
    source: "yahoo(open+close)+tiingo(adj_close)",
    adjustedOnlySource: "tiingo(adj_close)",
  });

  if (merged.missingRawDates.length > 0) {
    console.warn(
      `  ! index-nq retained ${merged.missingRawDates.length} Tiingo adjusted-only row(s) without matching Yahoo ^NDX bars: ${merged.missingRawDates.join(", ")}`
    );
  }

  return merged.rows;
}

// ============================================================================
// CSV Generation Functions
// ============================================================================

async function generateEtfCsv(ticker: string, fetchFn: () => Promise<DailyPrice[]>, forceRebuild = false): Promise<void> {
  const upperTicker = ticker.toUpperCase();
  const filename = `etf-${ticker.toLowerCase()}.csv`;

  await generateIncrementalSimplePriceCsv({
    filename,
    label: upperTicker,
    fetchFullRows: fetchFn,
    fetchFreshRows: async (startDate) => {
      const rows = await fetchTiingoRows(upperTicker, startDate);
      return rows.map((row) => ({
        date: row.date,
        adj_close: row.adjClose,
        name: upperTicker,
        source: "tiingo",
      }));
    },
    allowRatioRebaseOnMismatch: true,
    gapThreshold: 10,
    forceRebuild,
  });
}

async function generateIndexSpCsv(forceRebuild = false): Promise<void> {
  await generateIncrementalIndexCsv({
    filename: "index-sp.csv",
    label: "S&P 500",
    fetchFreshRows: fetchIndexSpRecentRows,
    fetchFullRows: fetchIndexSpHistory,
    forceRebuild,
    yahooSymbol: "^GSPC",
    modernName: "VOO",
  });
}

async function generateIndexNqCsv(forceRebuild = false): Promise<void> {
  await generateIncrementalIndexCsv({
    filename: "index-nq.csv",
    label: "Nasdaq 100",
    fetchFreshRows: fetchIndexNqRecentRows,
    fetchFullRows: fetchIndexNqHistory,
    forceRebuild,
    yahooSymbol: "^NDX",
    modernName: "QQQ",
  });
}

async function generateRiskOffCsv(asset: string, fetchFn: () => Promise<DailyPrice[]>, forceRebuild = false): Promise<void> {
  const assetLower = asset.toLowerCase().replace(".", "");
  const gapThreshold = asset === "GLDM" ? 400 : 35;
  const tiingoTickerByAsset: Record<string, string> = {
    SGOV: "SGOV",
    VGSH: "VGSH",
    GLDM: "GLDM",
    "BRK.A": "BRK-A",
  };

  const allowRatioRebaseOnMismatch = true;

  await generateIncrementalSimplePriceCsv({
    filename: `risk-${assetLower}.csv`,
    label: asset,
    fetchFullRows: fetchFn,
    fetchFreshRows: async (startDate) => {
      const ticker = tiingoTickerByAsset[asset];
      const rows = await fetchTiingoRows(ticker, startDate);
      return rows.map((row) => ({
        date: row.date,
        adj_open: row.adjOpen,
        adj_close: row.adjClose,
        name: ticker,
        source: "tiingo",
      }));
    },
    allowRatioRebaseOnMismatch,
    gapThreshold,
    includeAdjOpen: true,
    forceRebuild,
  });
}

async function generateInflationCsv(forceRebuild = false): Promise<void> {
  await generateIncrementalValueCsv({
    filename: "inflation.csv",
    label: "CPI",
    fetchFullRows: (tailDate) => fetchInflationHistory(tailDate),
    fetchFreshRows: async (startDate) => {
      const fredRows = await fetchFredSeries("CPIAUCSL", `${startDate}-01`, undefined, {
        carryForwardMissing: true,
      });
      return fredRows.map((row) => ({
        date: row.date.slice(0, 7),
        value: row.value,
        name: "CPIAUCSL",
        source: row.carriedForward ? "fred-carry-forward" : "fred",
      }));
    },
    forceRebuild,
  });
}

async function generateRateCsv(rateType: string, forceRebuild = false): Promise<void> {
  await generateIncrementalValueCsv({
    filename: `rate-${rateType}.csv`,
    label: rateType.toUpperCase(),
    fetchFullRows: (tailDate) => fetchRateHistory(rateType, tailDate),
    fetchFreshRows: async (startDate) => {
      if (rateType !== "borrow") {
        throw new Error(`Unknown rate type "${rateType}". Available: borrow`);
      }

      const fredRows = await fetchFredSeries("SOFR", startDate);
      return fredRows.map((row) => ({
        date: row.date,
        value: row.value / 100,
        name: "SOFR",
        source: "fred",
      }));
    },
    forceRebuild,
  });
}

// ============================================================================
// Main Functions
// ============================================================================

export async function fetchAll(forceRebuild = false) {
  console.log("=== Fetching all data ===\n");

  const errors: string[] = [];

  console.log("\n=== Generating Index Files ===");
  try {
    await generateIndexSpCsv(forceRebuild);
  } catch (err) {
    errors.push(`index-sp: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await generateIndexNqCsv(forceRebuild);
  } catch (err) {
    errors.push(`index-nq: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n=== Generating Inflation & Rate Files ===");
  try {
    await generateInflationCsv(forceRebuild);
  } catch (err) {
    errors.push(`inflation: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await generateRateCsv("borrow", forceRebuild);
  } catch (err) {
    errors.push(`rate-borrow: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n=== Generating Risk-Off Files ===");
  const riskOffFetchers: Array<{ asset: string; fetchFn: () => Promise<DailyPrice[]> }> = [
    { asset: "SGOV", fetchFn: fetchSgovHistory },
    { asset: "VGSH", fetchFn: fetchVgshHistory },
    { asset: "GLDM", fetchFn: fetchGldmHistory },
    { asset: "BRK.A", fetchFn: fetchBrkaHistory },
  ];

  for (const { asset, fetchFn } of riskOffFetchers) {
    try {
      await generateRiskOffCsv(asset, fetchFn, forceRebuild);
    } catch (err) {
      errors.push(`${asset}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n=== Generating ETF Files ===");
  const etfFetchers: Array<{ ticker: string; fetchFn: () => Promise<DailyPrice[]> }> = [
    { ticker: "UPRO", fetchFn: fetchUproHistory },
    { ticker: "TQQQ", fetchFn: fetchTqqqHistory },
    { ticker: "SSO", fetchFn: fetchSsoHistory },
    { ticker: "QLD", fetchFn: fetchQldHistory },
  ];

  for (const { ticker, fetchFn } of etfFetchers) {
    try {
      await generateEtfCsv(ticker, fetchFn, forceRebuild);
    } catch (err) {
      errors.push(`${ticker}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    console.error("\n=== Errors occurred during fetch ===");
    for (const e of errors) console.error(` - ${e}`);
  }

  console.log("\nDone!");
}

async function fetchEtf(ticker: string, forceRebuild = false) {
  const upperTicker = ticker.toUpperCase();
  if (!ETFS.includes(upperTicker as typeof ETFS[number])) {
    console.error(`Error: Unknown ETF "${ticker}". Available: ${ETFS.join(", ")}`);
    process.exit(1);
  }

  const fetchers: Record<string, () => Promise<DailyPrice[]>> = {
    UPRO: fetchUproHistory,
    TQQQ: fetchTqqqHistory,
    SSO: fetchSsoHistory,
    QLD: fetchQldHistory,
  };

  console.log(`=== Fetching ETF ${upperTicker} ===`);

  try {
    await generateEtfCsv(upperTicker, fetchers[upperTicker], forceRebuild);
    console.log(`\n✓ ${upperTicker} fetched successfully`);
  } catch (err) {
    console.error(`\n✗ ${upperTicker} fetch failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function fetchRiskOff(asset?: string, forceRebuild = false) {
  const fetchers: Record<string, () => Promise<DailyPrice[]>> = {
    SGOV: fetchSgovHistory,
    VGSH: fetchVgshHistory,
    GLDM: fetchGldmHistory,
    "BRK.A": fetchBrkaHistory,
  };

  if (!asset || asset === "all" || asset === "risk-off") {
    console.log("=== Generating all risk-off asset files ===");
    for (const [assetName, fetchFn] of Object.entries(fetchers)) {
      try {
        await generateRiskOffCsv(assetName, fetchFn, forceRebuild);
      } catch (err) {
        console.error(`${assetName} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } else {
    const assetUpper = asset.toUpperCase().replace("RISK-", "").replace("BRKA", "BRK.A");
    if (fetchers[assetUpper]) {
      await generateRiskOffCsv(assetUpper, fetchers[assetUpper], forceRebuild);
    } else {
      console.error(`Error: Unknown asset "${asset}". Available: sgov, vgsh, gldm, brk.a, all`);
      process.exit(1);
    }
  }
}

async function fetchIndex(indexName: string, options?: { forceRebuild?: boolean }) {
  const forceRebuild = options?.forceRebuild ?? false;
  if (indexName === "index-sp" || indexName === "sp") {
    console.log("=== Generating index-sp.csv (S&P 500) ===");
    await generateIndexSpCsv(forceRebuild);
  } else if (indexName === "index-nq" || indexName === "nq") {
    console.log("=== Generating index-nq.csv (Nasdaq 100) ===");
    await generateIndexNqCsv(forceRebuild);
  } else {
    console.error(`Error: Unknown index "${indexName}". Available: index-sp, index-nq`);
    process.exit(1);
  }
}

async function fetchInflation(forceRebuild = false) {
  console.log("=== Generating inflation.csv (CPI) ===");
  await generateInflationCsv(forceRebuild);
}

async function fetchRates(rateType?: string, forceRebuild = false) {
  if (!rateType || rateType === "all" || rateType === "rates") {
    console.log("=== Generating borrow rate file ===");
    try {
      await generateRateCsv("borrow", forceRebuild);
    } catch (err) {
      console.error(`borrow failed:`, err instanceof Error ? err.message : err);
    }
  } else if (rateType === "borrow") {
    try {
      await generateRateCsv(rateType, forceRebuild);
    } catch (err) {
      console.error(`${rateType} failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else {
    console.error(`Error: Unknown rate type "${rateType}". Available: borrow, all`);
    process.exit(1);
  }
}

async function main() {
  const allArgs = process.argv.slice(2);
  const forceRebuild = allArgs.includes("--rebuild") || allArgs.includes("--force") || allArgs.includes("--force-rebuild");
  const args = allArgs.filter(arg => !arg.startsWith("--"));

  if (allArgs[0] === "--etf" || allArgs[0] === "-e") {
    if (!args[0]) {
      console.error("Error: ETF ticker required. Usage: npm run fetch-data -- --etf TQQQ");
      process.exit(1);
    }
    await fetchEtf(args[0], forceRebuild);
  } else if (allArgs[0] === "--risk-off" || allArgs[0] === "-o") {
    await fetchRiskOff(args[0], forceRebuild);
  } else if (allArgs[0] === "--index" || allArgs[0] === "-i") {
    if (!args[0]) {
      console.error("Error: Index name required. Usage: npm run fetch-data -- --index index-sp");
      process.exit(1);
    }
    await fetchIndex(args[0], { forceRebuild });
  } else if (allArgs[0] === "--inflation") {
    await fetchInflation(forceRebuild);
  } else if (allArgs[0] === "--rates" || allArgs[0] === "-r") {
    await fetchRates(args[0], forceRebuild);
  } else if (args.length === 0) {
    await fetchAll(forceRebuild);
  } else if (["index-sp", "index-nq", "sp", "nq"].includes(args[0])) {
    await fetchIndex(args[0], { forceRebuild });
  } else if (args[0] === "inflation") {
    await fetchInflation(forceRebuild);
  } else if (["rates", "borrow"].includes(args[0])) {
    await fetchRates(args[0].replace("rate-", ""), forceRebuild);
  } else if (["risk-off", "risk-sgov", "risk-vgsh", "risk-gldm", "risk-brka", "sgov", "vgsh", "gldm", "brka", "brk.a"].includes(args[0])) {
    await fetchRiskOff(args[0], forceRebuild);
  } else {
    await fetchEtf(args[0], forceRebuild);
  }
}

function isCliInvocation(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isCliInvocation()) {
  main().catch((err) => {
    console.error("Fetch failed:", err);
    process.exit(1);
  });
}

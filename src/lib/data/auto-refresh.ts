import { access, constants } from "node:fs/promises";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");

const MARKET_CLOSE_PLUS_3H_NY_HOUR = 19;
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

let inProgress = false;
let lastAttemptAt: number | null = null;
let lastSuccessNyDate: string | null = null;
let writeAccessCached: boolean | null = null;

function isAutoRefreshDisabled(): boolean {
  return process.env.AUTO_REFRESH_DATA === "false";
}

function hasRequiredApiKeys(): boolean {
  return Boolean(process.env.TIINGO_API_KEY && process.env.FRED_API_KEY);
}

function getNyHour(now: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  });
  return Number(formatter.format(now));
}

function getNyDateKey(now: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

async function canWriteToDataDir(): Promise<boolean> {
  if (writeAccessCached !== null) return writeAccessCached;
  try {
    await access(DATA_DIR, constants.W_OK);
    writeAccessCached = true;
  } catch (err) {
    // ENOENT just means data/ hasn't been created yet — fetch-data will
    // create it on first write. Anything else (typically EACCES on a
    // read-only function bundle like Vercel) is a real "can't write".
    writeAccessCached = (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  return writeAccessCached;
}

/**
 * Fire-and-forget trigger called from hot paths. Returns immediately.
 *
 * Actual refresh runs in the background only when ALL gates pass:
 *   - not explicitly disabled (AUTO_REFRESH_DATA=false)
 *   - TIINGO_API_KEY and FRED_API_KEY are set
 *   - data/ directory is writable (skips Vercel automatically since the
 *     function bundle is read-only)
 *   - NY local time is >= 19:00 (market close 16:00 + 3h)
 *   - we have not already succeeded today (NY date)
 *   - last attempt was either never or > 30 minutes ago
 *   - no refresh is currently in progress
 *
 * Any error during the actual fetch is logged and swallowed — the app
 * keeps working with whatever data is already on disk.
 */
export function maybeRunAutoRefresh(): void {
  if (inProgress) return;
  if (isAutoRefreshDisabled()) return;
  if (!hasRequiredApiKeys()) return;

  const now = new Date();
  if (getNyHour(now) < MARKET_CLOSE_PLUS_3H_NY_HOUR) return;

  const todayNy = getNyDateKey(now);
  if (lastSuccessNyDate === todayNy) return;

  const nowMs = now.getTime();
  if (lastAttemptAt !== null && nowMs - lastAttemptAt < RETRY_COOLDOWN_MS) return;

  inProgress = true;
  lastAttemptAt = nowMs;

  void (async () => {
    try {
      if (!(await canWriteToDataDir())) {
        return;
      }
      const { fetchAll } = await import("../../../scripts/fetch-data");
      await fetchAll();
      lastSuccessNyDate = todayNy;
      console.log(`[auto-refresh] data refresh succeeded for NY date ${todayNy}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[auto-refresh] refresh attempt failed (will retry later): ${message}`);
    } finally {
      inProgress = false;
    }
  })();
}

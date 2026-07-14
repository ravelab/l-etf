import { Redis } from "@upstash/redis";

const KEY = "build:weekly-tasks:last-run-trading-date";

let redisClient: Redis | null = null;

function hasRedisConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Redis is not configured");
  redisClient ??= new Redis({ url, token });
  return redisClient;
}

export function isWeeklyBuildMarkerStorageReady(): boolean {
  return hasRedisConfig();
}

export async function readLastWeeklyRunTradingDate(): Promise<string | null> {
  if (!hasRedisConfig()) return null;
  const value = await getRedis().get<string>(KEY);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export async function writeLastWeeklyRunTradingDate(dateKey: string): Promise<void> {
  if (!hasRedisConfig()) return;
  await getRedis().set(KEY, dateKey);
}

function dateKeyInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error(`Failed to format date for ${timeZone}`);
  return `${year}-${month}-${day}`;
}

export function newYorkDateKey(date: Date): string {
  return dateKeyInTimeZone(date, "America/New_York");
}

/**
 * Monday-of-week for a YYYY-MM-DD date key. Sat/Sun map to the prior Monday so a
 * trading week is always Mon-Fri anchored. Pure date arithmetic — no timezone needed.
 */
export function mondayOfWeek(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = dt.getUTCDay();
  const offset = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - offset);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

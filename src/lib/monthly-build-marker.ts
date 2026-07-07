import { Redis } from "@upstash/redis";

const KEY = "build:monthly-tasks:last-run-month";

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

export function isMonthlyBuildMarkerStorageReady(): boolean {
  return hasRedisConfig();
}

export async function readLastMonthlyRunMonth(): Promise<string | null> {
  if (!hasRedisConfig()) return null;
  const value = await getRedis().get<string>(KEY);
  return typeof value === "string" && /^\d{4}-\d{2}$/.test(value) ? value : null;
}

export async function writeLastMonthlyRunMonth(monthKey: string): Promise<void> {
  if (!hasRedisConfig()) return;
  await getRedis().set(KEY, monthKey);
}

/**
 * True when a YYYY-MM-DD date key falls on the first Monday of its calendar
 * month. Pure date arithmetic (no trading-calendar lookup) — the user asked
 * for the literal first Monday of the month, not the first trading day.
 */
export function isFirstMondayOfMonth(dateKey: string): boolean {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.getUTCDay() === 1 && d <= 7;
}

/** "YYYY-MM" month key for a YYYY-MM-DD date key. */
export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

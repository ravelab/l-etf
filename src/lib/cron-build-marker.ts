import { Redis } from "@upstash/redis";

const CRON_TRIGGERED_BUILD_MARKER_KEY = "cron:refresh-data:pending-build";
const CRON_TRIGGERED_BUILD_MARKER_TTL_SECONDS = 60 * 60;
const CRON_LAST_TRIGGER_DATE_KEY = "cron:refresh-data:last-trigger-ny-date";
const CRON_LAST_TRIGGER_DATE_TTL_SECONDS = 30 * 60 * 60;

let redisClient: Redis | null = null;

function hasRedisConfig(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Redis is not configured");
  }
  redisClient ??= new Redis({ url, token });
  return redisClient;
}

export function isCronBuildMarkerStorageReady(): boolean {
  return hasRedisConfig();
}

export async function markNextBuildAsCronTriggered(details: Record<string, unknown>) {
  if (!hasRedisConfig()) return false;

  await getRedis().set(
    CRON_TRIGGERED_BUILD_MARKER_KEY,
    {
      ...details,
      markedAt: new Date().toISOString(),
    },
    { ex: CRON_TRIGGERED_BUILD_MARKER_TTL_SECONDS },
  );
  return true;
}

export async function consumeCronTriggeredBuildMarker() {
  if (!hasRedisConfig()) return null;

  const redis = getRedis();
  const marker = await redis.get<Record<string, unknown>>(CRON_TRIGGERED_BUILD_MARKER_KEY);
  if (marker) {
    await redis.del(CRON_TRIGGERED_BUILD_MARKER_KEY);
  }
  return marker;
}

export async function clearCronTriggeredBuildMarker() {
  if (!hasRedisConfig()) return false;

  await getRedis().del(CRON_TRIGGERED_BUILD_MARKER_KEY);
  return true;
}

export async function readLastCronTriggerNyDate(): Promise<string | null> {
  if (!hasRedisConfig()) return null;
  return getRedis().get<string>(CRON_LAST_TRIGGER_DATE_KEY);
}

export async function recordCronTriggerNyDate(nyDate: string): Promise<boolean> {
  if (!hasRedisConfig()) return false;
  await getRedis().set(CRON_LAST_TRIGGER_DATE_KEY, nyDate, {
    ex: CRON_LAST_TRIGGER_DATE_TTL_SECONDS,
  });
  return true;
}

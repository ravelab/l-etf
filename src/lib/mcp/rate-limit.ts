// Rate limiting for the MCP endpoint. Backed by Upstash Redis when the same
// env vars the rest of the app uses are present; otherwise a per-instance
// in-memory fallback so the endpoint still works locally and without Upstash.
//
// A global per-IP limit defends the whole endpoint; a stricter per-IP limit
// applies to the compute-heavy sweep tools. Limiter outages never fail a
// request — on a Redis error we fall back to the in-memory counter.

import { Redis } from "@upstash/redis";
import {
  MCP_RL_GLOBAL_LIMIT,
  MCP_RL_HEAVY_LIMIT,
  MCP_RL_WINDOW_SEC,
  MCP_HEAVY_TOOLS,
} from "@/lib/mcp/limits";

let redisClient: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  redisClient = url && token ? new Redis({ url, token }) : null;
  return redisClient;
}

const memBuckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

function memLimit(key: string, limit: number, windowSec: number): RateLimitResult {
  const now = Date.now();
  const bucket = memBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memBuckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, retryAfterSec: 0, limit, remaining: limit - 1 };
  }
  bucket.count += 1;
  const ok = bucket.count <= limit;
  return {
    ok,
    retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    limit,
    remaining: Math.max(0, limit - bucket.count),
  };
}

/** Fixed-window rate-limit check for `key`. */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const redis = getRedis();
  if (redis) {
    try {
      const redisKey = `mcp:rl:${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.expire(redisKey, windowSec);
      const ok = count <= limit;
      let retryAfterSec = 0;
      if (!ok) {
        const ttl = await redis.ttl(redisKey);
        retryAfterSec = ttl > 0 ? ttl : windowSec;
      }
      return { ok, retryAfterSec, limit, remaining: Math.max(0, limit - count) };
    } catch {
      // Fall through to the in-memory limiter on any Redis error.
    }
  }
  return memLimit(key, limit, windowSec);
}

/** Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). */
function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Inspect a Streamable-HTTP POST body to see whether it invokes one of the
 * compute-heavy tools. Returns false on any parse error (treated as light).
 */
async function isHeavyToolCall(request: Request): Promise<boolean> {
  try {
    const text = await request.clone().text();
    if (!text) return false;
    const parsed = JSON.parse(text) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((m) => {
      const msg = m as { method?: string; params?: { name?: string } };
      return msg?.method === "tools/call" && !!msg.params?.name && MCP_HEAVY_TOOLS.has(msg.params.name);
    });
  } catch {
    return false;
  }
}

function tooManyResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Rate limit exceeded. Slow down and retry." },
      id: null,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfterSec || MCP_RL_WINDOW_SEC),
      },
    },
  );
}

/**
 * Enforce MCP rate limits for an incoming request. Returns a 429 `Response`
 * when the caller is over a limit, or `null` to let the request proceed.
 */
export async function enforceMcpRateLimit(request: Request): Promise<Response | null> {
  const ip = clientIp(request);

  const global = await rateLimit(`ip:${ip}`, MCP_RL_GLOBAL_LIMIT, MCP_RL_WINDOW_SEC);
  if (!global.ok) return tooManyResponse(global);

  if (request.method === "POST" && (await isHeavyToolCall(request))) {
    const heavy = await rateLimit(`heavy:${ip}`, MCP_RL_HEAVY_LIMIT, MCP_RL_WINDOW_SEC);
    if (!heavy.ok) return tooManyResponse(heavy);
  }

  return null;
}

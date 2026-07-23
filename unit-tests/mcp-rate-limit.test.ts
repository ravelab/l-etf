import test from "node:test";
import assert from "node:assert/strict";
import { enforceMcpRateLimit, rateLimit } from "@/lib/mcp/rate-limit";
import { MCP_RL_HEAVY_LIMIT } from "@/lib/mcp/limits";

test("fixed-window limiter blocks after the limit and reports retry-after", async () => {
  const key = `test-${Math.random()}`;
  const first = await rateLimit(key, 2, 60);
  const second = await rateLimit(key, 2, 60);
  const third = await rateLimit(key, 2, 60);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.ok(third.retryAfterSec > 0);
});

function mcpPost(ip: string, toolName?: string): Request {
  const body = toolName
    ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName } })
    : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body,
  });
}

test("heavy tool calls hit the stricter per-IP budget", async () => {
  const ip = `9.9.9.${Math.floor(Math.random() * 1000)}`;
  let blocked = false;
  // One extra call beyond the heavy limit should trip a 429.
  for (let i = 0; i < MCP_RL_HEAVY_LIMIT + 1; i++) {
    const res = await enforceMcpRateLimit(mcpPost(ip, "compare_strategies"));
    if (res) {
      blocked = true;
      assert.equal(res.status, 429);
      assert.ok(res.headers.get("Retry-After"));
      break;
    }
  }
  assert.ok(blocked, "heavy limit should trip");
});

test("light requests are not blocked by the heavy budget", async () => {
  const ip = `8.8.8.${Math.floor(Math.random() * 1000)}`;
  // The heavy limit is well below the global limit, so this many light calls
  // (fewer than the global limit) must all pass.
  for (let i = 0; i < MCP_RL_HEAVY_LIMIT + 5; i++) {
    const res = await enforceMcpRateLimit(mcpPost(ip));
    assert.equal(res, null, "light request should not be blocked");
  }
});

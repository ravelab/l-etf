import test from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/lib/mcp/rate-limit";
import { McpToolError, toolError } from "../src/lib/mcp/tool-result";

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com/mcp", { method: "POST", headers });
}

test("client IP is not taken from the spoofable leftmost x-forwarded-for entry", () => {
  // A caller can put anything at the left of XFF; the trusted proxy appends on
  // the right. Keying the budget on the left makes every limit resettable.
  assert.equal(
    clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" })),
    "203.0.113.7"
  );
});

test("edge-set headers win over x-forwarded-for", () => {
  assert.equal(
    clientIp(req({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.1.1.1" })),
    "203.0.113.9"
  );
  assert.equal(
    clientIp(req({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "1.1.1.1" })),
    "203.0.113.8"
  );
  assert.equal(clientIp(req({})), "unknown");
});

test("internal errors are not leaked to unauthenticated MCP callers", () => {
  const leaky = new Error(
    "ENOENT: no such file or directory, open '/var/task/src/lib/tool-snapshots/futures.json'"
  );
  const text = toolError(leaky).content[0].text;
  assert.ok(!text.includes("/var/task"), `internal path leaked: ${text}`);
  assert.ok(!text.includes("ENOENT"), `internal errno leaked: ${text}`);
  assert.equal(text, "Error: Unexpected error running tool.");
});

test("user-facing McpToolError messages are still surfaced", () => {
  const text = toolError(new McpToolError("startDate must be before endDate.")).content[0].text;
  assert.equal(text, "Error: startDate must be before endDate.");
});

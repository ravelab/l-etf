import test from "node:test";
import assert from "node:assert/strict";
import { formatToolCallLog, parseToolCallNames } from "@/lib/mcp/request-info";

function postRequest(body: unknown): Request {
  return new Request("https://l-etf.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("parseToolCallNames finds the tool in a tools/call request", async () => {
  const names = await parseToolCallNames(
    postRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_backtest" } }),
  );
  assert.deepEqual(names, ["run_backtest"]);
});

test("parseToolCallNames handles a batch, preserving order", async () => {
  const names = await parseToolCallNames(
    postRequest([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_presets" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_backtest" } },
    ]),
  );
  assert.deepEqual(names, ["list_presets", "run_backtest"]);
});

test("parseToolCallNames ignores non-tool methods", async () => {
  const names = await parseToolCallNames(
    postRequest({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "letf://x" } }),
  );
  assert.deepEqual(names, []);
});

test("parseToolCallNames returns nothing for unparseable or empty bodies", async () => {
  assert.deepEqual(await parseToolCallNames(postRequest("not json")), []);
  assert.deepEqual(await parseToolCallNames(postRequest("")), []);
  assert.deepEqual(
    await parseToolCallNames(new Request("https://l-etf.com/mcp", { method: "GET" })),
    [],
  );
});

test("parseToolCallNames does not consume the body the handler still needs", async () => {
  const request = postRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run_backtest" },
  });
  await parseToolCallNames(request);
  assert.equal(request.bodyUsed, false, "the original request body must stay readable");
  const text = await request.text();
  assert.match(text, /run_backtest/);
});

test("the log line carries what capacity planning needs, on one line", () => {
  const line = formatToolCallLog({
    toolNames: ["compare_strategies"],
    durationMs: 1234,
    status: 200,
    rateLimited: false,
  });
  assert.ok(!line.includes("\n"), "must stay a single line");
  assert.match(line, /compare_strategies/);
  assert.match(line, /1234/);
  assert.match(line, /200/);
});

test("a request with no tool call is still identifiable in the log", () => {
  const line = formatToolCallLog({
    toolNames: [],
    durationMs: 5,
    status: 200,
    rateLimited: false,
  });
  assert.match(line, /-|none/i);
  assert.ok(!line.includes("\n"));
});

test("a rate-limited request says so", () => {
  const line = formatToolCallLog({
    toolNames: ["optimize_strategy"],
    durationMs: 2,
    status: 429,
    rateLimited: true,
  });
  assert.match(line, /429/);
  assert.match(line, /rate_limited|limited/i);
});

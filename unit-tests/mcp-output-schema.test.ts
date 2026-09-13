// Tools that declare an `outputSchema` are validated by the SDK on every call:
// a payload that drifts from its schema stops being a tool error and becomes a
// protocol error. These tests call each schema'd tool for real, so drift fails
// here rather than in a client.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { sanitizeNonFinite } from "@/lib/mcp/tool-result";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("sanitizeNonFinite replaces NaN and Infinity with null, in place of nothing else", () => {
  const input = {
    ok: 1.5,
    nan: NaN,
    inf: Infinity,
    negInf: -Infinity,
    zero: 0,
    text: "keep",
    flag: false,
    nothing: null,
    nested: { deep: [1, NaN, { x: Infinity }] },
  };
  assert.deepEqual(sanitizeNonFinite(input), {
    ok: 1.5,
    nan: null,
    inf: null,
    negInf: null,
    zero: 0,
    text: "keep",
    flag: false,
    nothing: null,
    nested: { deep: [1, null, { x: null }] },
  });
});

test("sanitizeNonFinite does not mutate its input", () => {
  const nested = { value: NaN };
  const input = { nested, list: [NaN] };
  const output = sanitizeNonFinite(input) as typeof input;
  assert.ok(Number.isNaN(nested.value), "source object untouched");
  assert.notEqual(output.nested, nested, "a new object is returned");
  assert.equal(output.nested.value, null);
});

test("sanitizeNonFinite leaves an already-clean payload structurally equal", () => {
  const input = { a: 1, b: "x", c: [1, 2], d: { e: true } };
  assert.deepEqual(sanitizeNonFinite(input), input);
});

test("schema'd tools advertise an output schema in tools/list", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  for (const name of [
    "run_backtest",
    "run_futures_backtest",
    "run_rolling_window_analysis",
    "compare_strategies",
  ]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is not registered`);
    assert.ok(tool?.outputSchema, `${name} declares no outputSchema`);
  }
  await client.close();
});

test("run_backtest output validates against its declared schema", async () => {
  const client = await connectClient();
  // A schema mismatch throws McpError out of callTool, so reaching the
  // assertions at all is most of the test.
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO", smaEnabled: true, startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { backtest: { cagrPct: number }; disclaimer: string };
  assert.ok(data.backtest, "structured content carries the backtest");
  assert.ok(typeof data.disclaimer === "string" && data.disclaimer.length > 0);
  await client.close();
});

test("a schema'd tool's text block is the summary, not a second copy of the payload", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO", startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  const text = (res.content as Array<{ text: string }>)[0].text;
  const structuredSize = JSON.stringify(res.structuredContent).length;
  assert.ok(text.length > 0, "there is still a human-readable text block");
  assert.ok(
    text.length < structuredSize,
    `text block (${text.length}) should not restate the payload (${structuredSize})`,
  );
  assert.ok(!text.includes('"disclaimer"'), "the JSON payload is not duplicated into text");
  await client.close();
});

test("run_futures_backtest output validates against its declared schema", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_futures_backtest",
    arguments: {
      index: "sp500",
      targetLeverage: 3,
      startDate: "1990-01-01",
      endDate: "2020-01-01",
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.ok((res.structuredContent as { futures: unknown }).futures);
  await client.close();
});

test("run_rolling_window_analysis validates with the opt-in distribution attached", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_rolling_window_analysis",
    arguments: {
      preset: "UPRO",
      smaEnabled: true,
      windowLength: 10,
      startDate: "1950-01-01",
      endDate: "2020-01-01",
      includePercentiles: true,
      includeWindows: true,
      maxWindows: 5,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    analysis: unknown;
    distribution: { windowCount: number; windows: unknown[] };
  };
  assert.ok(data.analysis);
  assert.ok(data.distribution.windowCount > 0);
  assert.ok(Array.isArray(data.distribution.windows));
  await client.close();
});

test("compare_strategies validates on the flat ranking branch", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "sma_on_off",
      windowLength: 10,
      startDate: "1950-01-01",
      endDate: "2020-01-01",
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { results: unknown[]; mode: string };
  assert.equal(data.mode, "sma_on_off");
  assert.ok(data.results.length >= 2);
  await client.close();
});

test("compare_strategies validates on the 2-D buffer-grid branch", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "asymmetric_buffers",
      windowLength: 10,
      startDate: "1950-01-01",
      endDate: "2020-01-01",
      minUpperBuffer: 1,
      maxUpperBuffer: 2,
      minLowerBuffer: 1,
      maxLowerBuffer: 2,
      gridStep: 1,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { best: { upperBuffer: number }; cells: number };
  assert.ok(data.cells > 0);
  assert.ok(typeof data.best.upperBuffer === "number");
  await client.close();
});

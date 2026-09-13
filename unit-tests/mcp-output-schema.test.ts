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

/**
 * Connects AND calls tools/list, which is what a real client does first.
 *
 * That is not incidental: listing caches each tool's output schema on the
 * client, which then validates every result against the *generated JSON
 * Schema* — emitted with `additionalProperties: false` — rather than against
 * the zod object, which silently strips unknown keys. Without the list call
 * these tests exercise only the lenient server-side path and would pass on a
 * schema that every real client rejects.
 */
async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
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
    "optimize_strategy",
    "stress_test_strategy",
    "compare_futures_ladder",
    "get_forward_sma_returns",
    "list_presets",
    "get_market_data",
    "compare_backtests",
    "compare_letfs",
    "get_sma_signals",
    "run_holding_period_analysis",
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

test("list_presets validates against its declared schema", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "list_presets", arguments: {} });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { presets: unknown[]; riskOffAssets: unknown[] };
  assert.ok(data.presets.length > 0);
  assert.ok(data.riskOffAssets.length > 0);
  await client.close();
});

test("get_market_data validates on all three of its row shapes", async () => {
  const client = await connectClient();
  for (const args of [
    { dataType: "prices", index: "sp500", startDate: "2019-01-01", endDate: "2019-03-01" },
    { dataType: "borrowRates", startDate: "2019-01-01", endDate: "2019-03-01" },
    { dataType: "inflation", startDate: "2019-01-01", endDate: "2019-06-01" },
  ]) {
    const res = await client.callTool({ name: "get_market_data", arguments: args });
    assert.notEqual(res.isError, true, `${args.dataType}: ${JSON.stringify(res.content)}`);
    const data = res.structuredContent as { rows: unknown[]; dataType: string };
    assert.equal(data.dataType, args.dataType);
    assert.ok(data.rows.length > 0, `${args.dataType} returned no rows`);
  }
  await client.close();
});

test("get_sma_signals validates against its declared schema", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "get_sma_signals", arguments: {} });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { signals: { sp500: { signalLabel: string } } };
  assert.ok(data.signals.sp500.signalLabel.length > 0);
  await client.close();
});

test("compare_backtests and compare_letfs validate against their schemas", async () => {
  const client = await connectClient();
  const backtests = await client.callTool({
    name: "compare_backtests",
    arguments: { presets: ["UPRO", "SSO"], startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  assert.notEqual(backtests.isError, true, JSON.stringify(backtests.content));
  assert.equal((backtests.structuredContent as { backtests: unknown[] }).backtests.length, 2);

  const letfs = await client.callTool({
    name: "compare_letfs",
    arguments: { presets: ["UPRO", "TQQQ"], windowLength: 10, startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  assert.notEqual(letfs.isError, true, JSON.stringify(letfs.content));
  assert.ok((letfs.structuredContent as { results: unknown[] }).results.length > 0);
  await client.close();
});

test("run_holding_period_analysis validates, distribution included", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_holding_period_analysis",
    arguments: {
      preset: "UPRO",
      smaEnabled: true,
      windowLengths: [5, 10],
      startDate: "1950-01-01",
      endDate: "2020-01-01",
      includePercentiles: true,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    results: Array<{ windowLengthYears: number; distribution?: { windowCount: number } }>;
  };
  assert.equal(data.results.length, 2);
  assert.ok(data.results[0].distribution!.windowCount > 0);
  await client.close();
});

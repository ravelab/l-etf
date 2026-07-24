import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("registers all expected tools", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const expected of [
    "compare_backtests",
    "compare_letfs",
    "compare_strategies",
    "get_box_spread_apy",
    "get_market_data",
    "get_sma_calibration",
    "get_sma_signals",
    "list_presets",
    "run_backtest",
    "run_futures_backtest",
    "run_holding_period_analysis",
    "run_rolling_window_analysis",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  await client.close();
});

test("list_presets returns the preset catalog", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "list_presets", arguments: {} });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as { presets: unknown[] };
  assert.ok(Array.isArray(data.presets) && data.presets.length >= 8);
  await client.close();
});

test("run_backtest returns metrics and a disclaimer", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO", startDate: "2015-01-02", endDate: "2016-01-04" },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as {
    backtest: { finalMultiple: number };
    disclaimer: string;
  };
  assert.ok(data.backtest.finalMultiple > 0);
  assert.match(data.disclaimer, /NOT investment advice/i);
  await client.close();
});

test("compare_strategies ranks variants over rolling windows", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "sma_on_off",
      startDate: "2000-01-03",
      endDate: "2020-01-02",
      windowLength: 10,
    },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as {
    results: Array<{ label: string; avgReturnPct: number }>;
    disclaimer: string;
  };
  assert.ok(Array.isArray(data.results) && data.results.length === 2);
  // Sorted by average return, descending.
  assert.ok(data.results[0].avgReturnPct >= data.results[1].avgReturnPct);
  assert.match(data.disclaimer, /NOT investment advice/i);
  await client.close();
});

test("run_rolling_window_analysis returns a distribution", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_rolling_window_analysis",
    arguments: {
      preset: "UPRO",
      smaEnabled: true,
      startDate: "2000-01-03",
      endDate: "2020-01-02",
      windowLength: 10,
    },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as { analysis: { avgReturnPct: number; avgMaxDrawdownPct: number } };
  assert.ok(Number.isFinite(data.analysis.avgReturnPct));
  assert.ok(Number.isFinite(data.analysis.avgMaxDrawdownPct));
  await client.close();
});

test("compare_backtests runs simulated + real presets together", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_backtests",
    arguments: { presets: ["UPRO", "UPRO-real"], startDate: "2010-01-04", endDate: "2020-01-02" },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as { backtests: Array<{ name: string; finalMultiple: number }> };
  assert.equal(data.backtests.length, 2);
  assert.match(data.backtests[0].name, /UPRO/);
  await client.close();
});

test("run_futures_backtest returns futures metrics", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_futures_backtest",
    arguments: { index: "sp500", targetLeverage: 3, startDate: "2010-01-04", endDate: "2020-01-02" },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as { futures: { finalEquity: number; avgActualLeverageRiskOn: number } };
  assert.ok(data.futures.finalEquity > 0);
  await client.close();
});

test("run_backtest surfaces a clean error for a real-ETF preset", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO-real" },
  });
  assert.equal(res.isError, true);
  await client.close();
});

test("exposes methodology and data-coverage resources", async () => {
  const client = await connectClient();
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  assert.ok(uris.includes("letf://methodology"));
  assert.ok(uris.includes("letf://data-coverage"));

  const methodology = await client.readResource({ uri: "letf://methodology" });
  const first = methodology.contents[0] as { text?: string };
  assert.match(String(first.text), /methodology/i);
  await client.close();
});

test("exposes the analyze_strategy prompt", async () => {
  const client = await connectClient();
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "analyze_strategy"));
  const prompt = await client.getPrompt({ name: "analyze_strategy", arguments: { preset: "TQQQ" } });
  assert.ok(prompt.messages.length > 0);
  await client.close();
});

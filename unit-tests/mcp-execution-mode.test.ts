// `smaExecutionMode` must be reachable from the MCP surface, not pinned to the
// engine default: an agent checking whether a result survives a different fill
// assumption needs to vary it. Guards the plumbing from tool schema → EtfConfig.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { makeSweepEtfConfig } from "@/lib/simulation/sweep-items";
import { buildSmaOnOffConfigs } from "@/lib/mcp/compare-configs";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("resolveBacktest honours an explicit smaExecutionMode", () => {
  const { config } = resolveBacktest({
    preset: "UPRO",
    smaEnabled: true,
    smaExecutionMode: "trigger-day-close",
    startDate: "2015-01-02",
    endDate: "2016-01-04",
  });
  assert.equal(config.smaExecutionMode, "trigger-day-close");
});

test("resolveBacktest defaults smaExecutionMode to next-day-open", () => {
  const { config } = resolveBacktest({ preset: "UPRO", smaEnabled: true });
  assert.equal(config.smaExecutionMode, "next-day-open");
});

test("makeSweepEtfConfig forwards smaExecutionMode and omits it when unset", () => {
  const preset = { name: "UPRO", leverage: 3, expenseRatio: 0.91, simulated: true, index: "sp500" as const };
  const opts = {
    id: "x",
    name: "x",
    smaEnabled: true,
    smaPeriod: 200,
    smaUpperBuffer: 1,
    smaLowerBuffer: 1,
    riskOffAsset: "SGOV" as const,
  };
  assert.equal(makeSweepEtfConfig(preset, opts).smaExecutionMode, undefined);
  assert.equal(
    makeSweepEtfConfig(preset, { ...opts, smaExecutionMode: "next-day-close" }).smaExecutionMode,
    "next-day-close",
  );
});

test("compare_strategies config builders carry the base execution mode", () => {
  const { config: base } = resolveBacktest({
    preset: "UPRO",
    smaEnabled: true,
    smaExecutionMode: "next-day-close",
  });
  for (const config of buildSmaOnOffConfigs(base)) {
    assert.equal(config.smaExecutionMode, "next-day-close");
  }
});

test("run_backtest exposes smaExecutionMode and it changes the result", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const schema = tools.find((t) => t.name === "run_backtest")!.inputSchema as {
    properties: Record<string, unknown>;
  };
  assert.ok(schema.properties.smaExecutionMode, "run_backtest should accept smaExecutionMode");

  const args = {
    preset: "UPRO",
    smaEnabled: true,
    smaPeriod: 100,
    startDate: "2007-01-03",
    endDate: "2012-01-03",
  };
  const [nextOpen, triggerClose] = await Promise.all([
    client.callTool({ name: "run_backtest", arguments: { ...args, smaExecutionMode: "next-day-open" } }),
    client.callTool({ name: "run_backtest", arguments: { ...args, smaExecutionMode: "trigger-day-close" } }),
  ]);
  assert.notEqual(nextOpen.isError, true);
  assert.notEqual(triggerClose.isError, true);

  const a = (nextOpen.structuredContent as { backtest: { finalMultiple: number } }).backtest;
  const b = (triggerClose.structuredContent as { backtest: { finalMultiple: number } }).backtest;
  assert.notEqual(a.finalMultiple, b.finalMultiple, "fill timing should move the result");
  await client.close();
});

test("run_backtest rejects an unknown smaExecutionMode", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO", smaEnabled: true, smaExecutionMode: "same-day-open" },
  });
  assert.equal(res.isError, true);
  await client.close();
});

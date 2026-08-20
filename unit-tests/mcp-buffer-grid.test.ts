// The 2-D (upper, lower) buffer grid search is the /compare-threshold-strategies
// page's most distinctive analysis; `compare_strategies` mode `sma_buffers` can
// only sweep a symmetric band, so agents had no way to reach the asymmetric
// surface. These guard the grid mode's breadth limits and output shape.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { buildAsymmetricBufferConfigs } from "@/lib/mcp/compare-configs";
import { MAX_BUFFER_GRID_CELLS } from "@/lib/mcp/limits";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function base() {
  return resolveBacktest({ preset: "UPRO", smaEnabled: true, smaPeriod: 200 }).config;
}

test("buildAsymmetricBufferConfigs spans the full cartesian grid plus a baseline", () => {
  const { configs, grid } = buildAsymmetricBufferConfigs(base(), {
    minUpperBuffer: 1,
    maxUpperBuffer: 3,
    minLowerBuffer: 1,
    maxLowerBuffer: 2,
    gridStep: 1,
  });
  // 3 uppers x 2 lowers = 6 cells, plus the no-SMA baseline.
  assert.equal(configs.length, 7);
  assert.equal(grid.size, 6);

  const pairs = [...grid.values()].map((c) => `${c.upperBuffer}/${c.lowerBuffer}`).sort();
  assert.deepEqual(pairs, ["1/1", "1/2", "2/1", "2/2", "3/1", "3/2"]);
  assert.ok(configs.some((c) => c.smaUpperBuffer !== c.smaLowerBuffer), "grid must be asymmetric");
});

test("buildAsymmetricBufferConfigs rejects a grid past the cell budget", () => {
  assert.throws(
    () =>
      buildAsymmetricBufferConfigs(base(), {
        minUpperBuffer: 0,
        maxUpperBuffer: 10,
        minLowerBuffer: 0,
        maxLowerBuffer: 10,
        gridStep: 1,
      }),
    (err: Error) => {
      assert.match(err.message, new RegExp(String(MAX_BUFFER_GRID_CELLS)));
      assert.match(err.message, /121 cells/);
      return true;
    },
  );
});

test("compare_strategies advertises the asymmetric_buffers mode", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const schema = tools.find((t) => t.name === "compare_strategies")!.inputSchema as unknown as {
    properties: { mode: { enum?: string[] } };
  };
  assert.ok(schema.properties.mode.enum?.includes("asymmetric_buffers"));
  await client.close();
});

test("compare_strategies asymmetric_buffers returns a scored 2-D surface", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "asymmetric_buffers",
      minUpperBuffer: 1,
      maxUpperBuffer: 3,
      minLowerBuffer: 1,
      maxLowerBuffer: 3,
      gridStep: 1,
      startDate: "2000-01-03",
      endDate: "2020-01-02",
      windowLength: 10,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    mode: string;
    objective: string;
    inflationPct: number;
    best: { upperBuffer: number; lowerBuffer: number };
    results: Array<{ upperBuffer: number; lowerBuffer: number; score: number; avgReturnPct: number }>;
  };

  assert.equal(data.mode, "asymmetric_buffers");
  // 9 grid cells; the baseline is reported separately from the surface.
  assert.equal(data.results.length, 9);
  for (const row of data.results) {
    assert.equal(typeof row.upperBuffer, "number");
    assert.equal(typeof row.lowerBuffer, "number");
    assert.ok(Number.isFinite(row.score));
  }
  assert.ok(data.results.some((r) => r.upperBuffer !== r.lowerBuffer));
  // Rows arrive ranked by the objective.
  const scores = data.results.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(data.best.upperBuffer, data.results[0].upperBuffer);
  assert.equal(data.best.lowerBuffer, data.results[0].lowerBuffer);
  await client.close();
});

test("compare_strategies asymmetric_buffers rejects an oversized grid", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "asymmetric_buffers",
      minUpperBuffer: 0,
      maxUpperBuffer: 10,
      minLowerBuffer: 0,
      maxLowerBuffer: 10,
      gridStep: 1,
    },
  });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0].text, /cells/);
  await client.close();
});

test("grid inflation is a percent, matching the units scoreRow subtracts", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_strategies",
    arguments: {
      preset: "UPRO",
      mode: "asymmetric_buffers",
      minUpperBuffer: 1,
      maxUpperBuffer: 2,
      minLowerBuffer: 1,
      maxLowerBuffer: 2,
      gridStep: 1,
      startDate: "1990-01-02",
      endDate: "2020-01-02",
      objective: "avgRealCagr",
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    inflationPct: number;
    results: Array<{ score: number; avgReturnPct: number }>;
  };

  // US CPI ran ~2-3%/yr over 1990-2020. A fraction (0.025) here would silently
  // make the real-return objectives ~100x too generous, since the sweep rows
  // this is subtracted from are nominal percents.
  assert.ok(
    data.inflationPct > 1 && data.inflationPct < 10,
    `inflationPct ${data.inflationPct} is not an annual percent`,
  );
  // avgRealCagr scores are exactly the nominal return less that inflation.
  for (const row of data.results) {
    assert.ok(Math.abs(row.score - (row.avgReturnPct - data.inflationPct)) < 1e-9);
  }
  await client.close();
});

// Rolling-window tools reported only summary stats (avg/best/worst/win rate),
// so an agent could not do its own statistics without re-running sweeps to
// triangulate. These guard the opt-in percentile / raw-window output.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { summarizeWindowPoints } from "@/lib/mcp/window-distribution";
import type { RollingSimulationPoint } from "@/lib/simulation/rolling";
import { CONSTANT_INITIAL_INVESTMENT } from "@/lib/constants";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function point(i: number, cagr: number): RollingSimulationPoint {
  return {
    startDate: `20${String(i).padStart(2, "0")}-01-01`,
    endDate: `20${String(i + 10).padStart(2, "0")}-01-01`,
    finalValue: CONSTANT_INITIAL_INVESTMENT * (1 + i / 100),
    nonLeveragedFinalValue: CONSTANT_INITIAL_INVESTMENT,
    maxDrawdownPct: 20 + i,
    nonLeveragedMaxDrawdownPct: 10,
    cagr,
    totalReturnPct: i,
    tradeCount: i,
    totalTradingCostPct: 0.1,
  };
}

test("summarizeWindowPoints reports percentiles over every window", () => {
  const points = Array.from({ length: 101 }, (_, i) => point(i, i));
  const summary = summarizeWindowPoints(points, {});
  assert.equal(summary.windowCount, 101);
  assert.equal(summary.percentiles.cagrPct.p50, 50);
  assert.equal(summary.percentiles.cagrPct.p10, 10);
  assert.equal(summary.percentiles.cagrPct.p90, 90);
  assert.equal(summary.windows, undefined, "raw windows stay opt-in");
  assert.equal(summary.histogram.reduce((n, b) => n + b.count, 0), 101);
});

test("summarizeWindowPoints returns raw windows when asked", () => {
  const points = Array.from({ length: 5 }, (_, i) => point(i, i));
  const summary = summarizeWindowPoints(points, { includeWindows: true });
  assert.equal(summary.windows?.length, 5);
  assert.equal(summary.sampled, false);
  const first = summary.windows![0];
  assert.equal(first.startDate, points[0].startDate);
  assert.ok(first.finalMultiple > 0);
  assert.equal(typeof first.beat1x, "boolean");
});

test("summarizeWindowPoints strides oversized window lists but keeps full-set stats", () => {
  const points = Array.from({ length: 1000 }, (_, i) => point(i % 100, i % 100));
  const summary = summarizeWindowPoints(points, { includeWindows: true, maxWindows: 100 });
  assert.equal(summary.windowCount, 1000, "stats still describe every window");
  assert.equal(summary.sampled, true);
  assert.ok(summary.windows!.length <= 100);
  assert.ok((summary.sampleStride ?? 0) > 1);
});

test("run_rolling_window_analysis returns percentiles and windows on request", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_rolling_window_analysis",
    arguments: {
      preset: "UPRO",
      startDate: "2000-01-03",
      endDate: "2020-01-02",
      windowLength: 10,
      includeWindows: true,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    analysis: { avgReturnPct: number };
    distribution: {
      windowCount: number;
      sampled: boolean;
      percentiles: { cagrPct: { p10: number; p50: number; p90: number } };
      histogram: Array<{ count: number }>;
      windows?: Array<{ startDate: string; endDate: string; cagrPct: number }>;
    };
  };
  assert.ok(data.distribution.windowCount > 100);
  assert.ok(data.distribution.percentiles.cagrPct.p10 <= data.distribution.percentiles.cagrPct.p50);
  assert.ok(data.distribution.percentiles.cagrPct.p50 <= data.distribution.percentiles.cagrPct.p90);
  assert.ok(Array.isArray(data.distribution.windows) && data.distribution.windows.length > 0);
  assert.ok(data.distribution.windows![0].startDate < data.distribution.windows![0].endDate);
  await client.close();
});

test("run_rolling_window_analysis omits the distribution unless asked", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_rolling_window_analysis",
    arguments: { preset: "UPRO", startDate: "2000-01-03", endDate: "2020-01-02", windowLength: 10 },
  });
  assert.notEqual(res.isError, true);
  const data = res.structuredContent as { distribution?: unknown };
  assert.equal(data.distribution, undefined);
  await client.close();
});

test("run_holding_period_analysis can attach percentiles per holding period", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_holding_period_analysis",
    arguments: {
      preset: "UPRO",
      startDate: "2000-01-03",
      endDate: "2020-01-02",
      windowLengths: [5, 10],
      includePercentiles: true,
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    results: Array<{
      windowLengthYears: number;
      distribution?: {
        windowCount: number;
        percentiles: { cagrPct: { p50: number } };
        windows?: unknown[];
      };
    }>;
  };
  assert.equal(data.results.length, 2);
  for (const row of data.results) {
    assert.ok(row.distribution, `missing distribution for ${row.windowLengthYears}y`);
    assert.ok(row.distribution!.windowCount > 0);
    assert.ok(Number.isFinite(row.distribution!.percentiles.cagrPct.p50));
    assert.equal(row.distribution!.windows, undefined, "raw windows stay off here");
  }
  await client.close();
});

// The site ships precomputed canonical runs for every tool page. Exposing them
// over MCP lets an agent answer the common questions instantly instead of
// spending the heavy rate-limit budget re-running the engine. These guard the
// catalog, the distillation (no megabyte daily arrays), and the history-wrap
// caveat that separates snapshot numbers from live tool results.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { SNAPSHOT_ANALYSES } from "@/lib/mcp/snapshot-core";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client: Client, args: Record<string, unknown>) {
  const res = await client.callTool({ name: "get_precomputed_analysis", arguments: args });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  return res.structuredContent as Record<string, unknown>;
}

test("lists the snapshot catalog when no analysis is named", async () => {
  const client = await connectClient();
  const data = await call(client, {});
  const available = data.available as Array<{ analysis: string; generatedAt: string; snapshotEndDate: string }>;
  assert.equal(available.length, SNAPSHOT_ANALYSES.length);
  for (const entry of available) {
    assert.ok(SNAPSHOT_ANALYSES.includes(entry.analysis as (typeof SNAPSHOT_ANALYSES)[number]));
    assert.match(entry.generatedAt, /^\d{4}-\d{2}-\d{2}/);
    assert.match(entry.snapshotEndDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  await client.close();
});

test("every analysis distills to a compact payload with provenance", async () => {
  const client = await connectClient();
  for (const analysis of SNAPSHOT_ANALYSES) {
    const data = await call(client, { analysis });
    const snapshot = data.snapshot as {
      analysis: string;
      generatedAt: string;
      snapshotEndDate: string;
      sharedInputs: Record<string, unknown>;
      caveat: string;
      results: unknown;
    };
    assert.equal(snapshot.analysis, analysis);
    assert.ok(snapshot.generatedAt, `${analysis} missing generatedAt`);
    assert.ok(snapshot.sharedInputs, `${analysis} missing sharedInputs`);
    assert.match(snapshot.caveat, /history wrap/i, `${analysis} must flag the wrap difference`);
    assert.ok(snapshot.results, `${analysis} produced no results`);

    // The raw snapshots embed full daily series (backtesting is ~1.8MB,
    // futures ~4MB); the distilled payload must not carry them.
    const json = JSON.stringify(snapshot);
    assert.ok(json.length < 120_000, `${analysis} payload too large: ${json.length} bytes`);
    assert.ok(!json.includes('"dailyValues"'), `${analysis} leaked daily values`);
    assert.ok(!json.includes('"monthlyCpi"'), `${analysis} leaked the CPI series`);
  }
  await client.close();
});

test("backtesting snapshot reports per-strategy headline metrics", async () => {
  const client = await connectClient();
  const data = await call(client, { analysis: "backtesting" });
  const results = (data.snapshot as { results: { strategies: Array<Record<string, number | string>> } })
    .results;
  assert.ok(results.strategies.length >= 2);
  for (const row of results.strategies) {
    assert.equal(typeof row.name, "string");
    assert.equal(typeof row.cagrPct, "number");
    assert.equal(typeof row.finalMultiple, "number");
    assert.equal(typeof row.maxDrawdownPct, "number");
  }
  await client.close();
});

test("threshold snapshot returns the best asymmetric cells, not all 192", async () => {
  const client = await connectClient();
  const data = await call(client, { analysis: "compare-threshold" });
  const results = (
    data.snapshot as {
      results: {
        sp500: {
          asymmetricCellsEvaluated: number;
          topAsymmetricCells: Array<{ upperBuffer: number; lowerBuffer: number; avgCagrPct: number }>;
        };
      };
    }
  ).results;
  assert.ok(results.sp500.asymmetricCellsEvaluated > 100);
  assert.ok(results.sp500.topAsymmetricCells.length <= 15);
  assert.ok(results.sp500.topAsymmetricCells.length > 0);
  const cagrs = results.sp500.topAsymmetricCells.map((c) => c.avgCagrPct);
  assert.deepEqual(cagrs, [...cagrs].sort((a, b) => b - a), "cells should be ranked");
  await client.close();
});

test("rejects an unknown analysis", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "get_precomputed_analysis",
    arguments: { analysis: "not-a-page" },
  });
  assert.equal(res.isError, true);
  await client.close();
});

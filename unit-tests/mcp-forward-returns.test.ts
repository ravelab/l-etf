import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { runForwardSmaReturns } from "@/lib/mcp/forward-returns-core";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

const RANGE = { startDate: "1950-01-01", endDate: "2020-01-01" };

test("forward returns bin the history by gap to the SMA", async () => {
  const result = await runForwardSmaReturns({ preset: "UPRO", ...RANGE });
  assert.ok(result.observations > 1000, `only ${result.observations} observations`);
  assert.ok(result.bins.length > 3, `only ${result.bins.length} bins`);
  assert.equal(
    result.bins.reduce((sum, b) => sum + b.count, 0),
    result.observations,
    "every observation lands in exactly one bin",
  );
});

test("bins run from the most negative gap upward and never overlap", async () => {
  const result = await runForwardSmaReturns({ preset: "UPRO", ...RANGE });
  for (let i = 1; i < result.bins.length; i += 1) {
    assert.ok(
      result.bins[i].fromGapPct >= result.bins[i - 1].toGapPct,
      `bin ${i} starts at ${result.bins[i].fromGapPct}, before ${result.bins[i - 1].toGapPct}`,
    );
  }
});

test("each bin's percentiles are ordered and bracketed by its range", async () => {
  const result = await runForwardSmaReturns({ preset: "UPRO", ...RANGE });
  for (const bin of result.bins) {
    assert.ok(bin.minRealReturnPct <= bin.p10RealReturnPct, `${bin.label} min > p10`);
    assert.ok(bin.p10RealReturnPct <= bin.medianRealReturnPct, `${bin.label} p10 > median`);
    assert.ok(bin.medianRealReturnPct <= bin.p90RealReturnPct, `${bin.label} median > p90`);
    assert.ok(bin.p90RealReturnPct <= bin.maxRealReturnPct, `${bin.label} p90 > max`);
  }
});

test("the forward window length changes the observation count", async () => {
  const [oneYear, threeYear] = await Promise.all([
    runForwardSmaReturns({ preset: "UPRO", ...RANGE }, { forwardTradingDays: 252 }),
    runForwardSmaReturns({ preset: "UPRO", ...RANGE }, { forwardTradingDays: 756 }),
  ]);
  assert.equal(oneYear.forwardTradingDays, 252);
  assert.equal(threeYear.forwardTradingDays, 756);
  // A longer forward window fits fewer times in the same history.
  assert.ok(threeYear.observations < oneYear.observations);
});

test("a range too short for even one forward window is a clean error", async () => {
  await assert.rejects(
    () =>
      runForwardSmaReturns(
        { preset: "UPRO", startDate: "2019-01-01", endDate: "2019-06-01" },
        { forwardTradingDays: 2520 },
      ),
    /forward windows|price data/i,
  );
});

test("the tool carries the overlap caveat in its payload", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "get_forward_sma_returns",
    arguments: { preset: "UPRO", ...RANGE },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { note: string; bins: unknown[]; observations: number };
  // Overlapping windows are the thing most likely to be over-read here, so the
  // caveat travels in the payload rather than only in the tool description.
  assert.match(data.note, /overlap/i);
  assert.ok(data.bins.length > 0);
  await client.close();
});

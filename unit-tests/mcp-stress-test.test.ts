import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { runStressTest } from "@/lib/mcp/stress-core";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  // Priming tools/list makes the client validate results against the generated
  // JSON Schema, the way a real client does. See mcp-output-schema.test.ts.
  await client.listTools();
  return client;
}

interface StressPayload {
  strategy: string;
  index: string;
  windowsTested: number;
  episodes: Array<{
    name: string;
    startDate: string;
    endDate: string;
    strategyReturnPct: number;
    strategyMaxDrawdownPct: number;
    buyAndHoldReturnPct: number | null;
    index1xReturnPct: number;
    startedInvested: boolean | null;
    trades: number;
  }>;
  worstEpisode: { name: string; strategyReturnPct: number };
  skipped: Array<{ name: string; reason: string }>;
}

test("stress_test_strategy reports every episode the S&P data covers", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "UPRO", smaEnabled: true },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as unknown as StressPayload;

  assert.equal(data.index, "sp500");
  assert.ok(data.windowsTested >= 8, `only ${data.windowsTested} episodes ran`);
  assert.equal(data.episodes.length, data.windowsTested);
  for (const name of ["1929 Crash and Depression", "1973-74 Bear Market", "Global Financial Crisis"]) {
    assert.ok(data.episodes.some((e) => e.name === name), `missing ${name}`);
  }
  await client.close();
});

test("the unleveraged index really did fall in the episodes we call crises", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "UPRO", smaEnabled: true },
  });
  const data = res.structuredContent as unknown as StressPayload;
  // If the catalog's dates were wrong, this is what would catch it.
  for (const episode of data.episodes) {
    assert.ok(
      episode.index1xReturnPct < 0,
      `${episode.name}: the 1x index returned ${episode.index1xReturnPct.toFixed(1)}%, not a drawdown`,
    );
    assert.ok(episode.strategyMaxDrawdownPct > 0, `${episode.name} has no drawdown`);
  }
  await client.close();
});

test("each episode compares the timed strategy against holding the same LETF", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "UPRO", smaEnabled: true },
  });
  const data = res.structuredContent as unknown as StressPayload;
  for (const episode of data.episodes) {
    assert.ok(episode.buyAndHoldReturnPct != null, `${episode.name} has no buy-and-hold comparison`);
    assert.equal(typeof episode.startedInvested, "boolean");
  }
  // The 1973-74 bear is the case that ruins un-timed leverage; the timed rule
  // must do better there or the comparison is not wired up correctly.
  const bear = data.episodes.find((e) => e.name === "1973-74 Bear Market")!;
  assert.ok(
    bear.strategyReturnPct > bear.buyAndHoldReturnPct!,
    `timed ${bear.strategyReturnPct} should beat buy-and-hold ${bear.buyAndHoldReturnPct} in 1973-74`,
  );
  await client.close();
});

test("worstEpisode is the worst episode by strategy return", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "UPRO", smaEnabled: true },
  });
  const data = res.structuredContent as unknown as StressPayload;
  const min = Math.min(...data.episodes.map((e) => e.strategyReturnPct));
  assert.equal(data.worstEpisode.strategyReturnPct, min);
  await client.close();
});

test("a Nasdaq preset skips the episodes predating its data, and says which", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "TQQQ", smaEnabled: true },
  });
  const data = res.structuredContent as unknown as StressPayload;
  assert.equal(data.index, "nasdaq100");
  assert.equal(data.episodes.some((e) => e.name.includes("1929")), false);
  assert.equal(data.episodes.some((e) => e.name.includes("1907")), false);
  // The Nasdaq series starts in 1971, so 1973-74 IS in range.
  assert.ok(data.episodes.some((e) => e.name === "1973-74 Bear Market"));
  await client.close();
});

test("a buy-and-hold run omits the timing comparison rather than faking it", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "stress_test_strategy",
    arguments: { preset: "UPRO", smaEnabled: false },
  });
  const data = res.structuredContent as unknown as StressPayload;
  for (const episode of data.episodes) {
    assert.equal(episode.buyAndHoldReturnPct, null, "no SMA means no separate comparison");
    assert.equal(episode.trades, 0);
  }
  await client.close();
});

test("trade counts track the SMA period rather than being pinned", async () => {
  // The calibrated ~186-day SMA sells once per episode and stays out, which
  // looks suspiciously constant until you vary the period: a fast SMA whipsaws
  // through the same windows. This is what tells the two apart.
  const [slow, fast] = await Promise.all([
    runStressTest({ preset: "UPRO", smaEnabled: true, smaPeriod: 186 }),
    runStressTest({ preset: "UPRO", smaEnabled: true, smaPeriod: 20 }),
  ]);
  const total = (r: Awaited<ReturnType<typeof runStressTest>>) =>
    r.episodes.reduce((sum, e) => sum + e.trades, 0);
  assert.ok(
    total(fast) > total(slow) * 3,
    `a 20-day SMA (${total(fast)} trades) should churn far more than a 186-day one (${total(slow)})`,
  );
  const longBear = fast.episodes.find((e) => e.name === "1929 Crash and Depression")!;
  assert.ok(longBear.trades > 1, "a fast SMA must re-enter on the bear rallies");
});

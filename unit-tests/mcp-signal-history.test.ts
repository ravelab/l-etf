// `get_sma_signals` answers "what is the signal today" only. Questions like
// "when did it last flip", "how long have we been risk-on", and "how often does
// this band whipsaw" previously required running a full backtest just to read
// its trade log. These guard the dedicated history tool.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";

interface SignalHistory {
  index: string;
  startDate: string;
  endDate: string;
  config: { smaPeriod: number; smaUpperBuffer: number; smaLowerBuffer: number };
  current: { regime: "risk-on" | "risk-off"; since: string; tradingDays: number };
  stats: {
    flips: number;
    flipsPerYear: number;
    timeInMarketPct: number;
    longestRiskOnDays: number;
    longestRiskOffDays: number;
    medianDaysBetweenFlips: number | null;
  };
  crossovers: Array<{ date: string; type: "buy" | "sell"; price: number; tradingDaysHeld: number }>;
  series?: Array<{ date: string; close: number; sma: number; invested: boolean }>;
}

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function history(client: Client, args: Record<string, unknown>): Promise<SignalHistory> {
  const res = await client.callTool({ name: "get_sma_signal_history", arguments: args });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  return (res.structuredContent as { history: SignalHistory }).history;
}

test("get_sma_signal_history is registered", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === "get_sma_signal_history"));
  await client.close();
});

test("returns an alternating, in-range crossover log with a current regime", async () => {
  const client = await connectClient();
  const data = await history(client, {
    index: "sp500",
    smaPeriod: 200,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    startDate: "2000-01-03",
    endDate: "2020-01-02",
  });

  assert.ok(data.crossovers.length > 4, "20 years of a 200-day SMA should flip repeatedly");
  for (const [i, signal] of data.crossovers.entries()) {
    assert.ok(signal.date >= "2000-01-03" && signal.date <= "2020-01-02", `${signal.date} out of range`);
    if (i > 0) {
      assert.ok(signal.date > data.crossovers[i - 1].date, "crossovers must be chronological");
      assert.notEqual(signal.type, data.crossovers[i - 1].type, "buy/sell must alternate");
    }
  }

  assert.ok(["risk-on", "risk-off"].includes(data.current.regime));
  assert.ok(data.current.tradingDays > 0);
  assert.equal(data.stats.flips, data.crossovers.length);
  assert.ok(data.stats.timeInMarketPct > 0 && data.stats.timeInMarketPct <= 100);
  assert.ok(data.stats.longestRiskOnDays > 0);
  assert.ok(data.stats.flipsPerYear > 0 && data.stats.flipsPerYear < 52);
  await client.close();
});

test("a wider buffer band produces fewer flips than a bare crossing", async () => {
  const client = await connectClient();
  const args = { index: "sp500", smaPeriod: 200, startDate: "2000-01-03", endDate: "2020-01-02" };
  const [tight, wide] = await Promise.all([
    history(client, { ...args, smaUpperBuffer: 0, smaLowerBuffer: 0 }),
    history(client, { ...args, smaUpperBuffer: 5, smaLowerBuffer: 5 }),
  ]);
  assert.ok(wide.stats.flips < tight.stats.flips, "hysteresis should suppress whipsaws");
  await client.close();
});

test("the per-day series is opt-in", async () => {
  const client = await connectClient();
  const args = { index: "nasdaq100", smaPeriod: 100, startDate: "2015-01-02", endDate: "2018-01-02" };
  const withoutSeries = await history(client, args);
  assert.equal(withoutSeries.series, undefined);

  const withSeries = await history(client, { ...args, includeSeries: true });
  assert.ok((withSeries.series?.length ?? 0) > 0);
  const first = withSeries.series![0];
  assert.ok(first.date >= "2015-01-02");
  assert.ok(Number.isFinite(first.sma) && first.sma > 0);
  await client.close();
});

test("defaults to the calibrated band for the index when none is given", async () => {
  const client = await connectClient();
  const data = await history(client, { index: "sp500", startDate: "2018-01-02", endDate: "2020-01-02" });
  assert.ok(data.config.smaPeriod >= 5 && data.config.smaPeriod <= 500);
  assert.ok(data.config.smaUpperBuffer >= 0);
  await client.close();
});

test("rejects a start date that is not before the end date", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "get_sma_signal_history",
    arguments: { index: "sp500", startDate: "2020-01-02", endDate: "2019-01-02" },
  });
  assert.equal(res.isError, true);
  await client.close();
});

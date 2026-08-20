// The sweep tools can burn most of a 300s function budget in one call, and the
// endpoint streams the response, so a client that asked for progress should see
// advancement instead of a silent wait. Progress is opt-in per the MCP spec: no
// progressToken on the request means no notifications.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { registerAll } from "@/lib/mcp/register";
import { makeProgressReporter } from "@/lib/mcp/progress";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function fakeExtra(progressToken?: string | number) {
  const sent: Array<Record<string, unknown>> = [];
  const extra = {
    _meta: progressToken == null ? undefined : { progressToken },
    sendNotification: async (notification: { params: Record<string, unknown> }) => {
      sent.push(notification.params);
    },
  };
  return { extra, sent };
}

test("no progressToken means no reporter and no work", () => {
  const { extra } = fakeExtra();
  assert.equal(makeProgressReporter(extra as never), undefined);
});

test("reporter throttles, stays monotonic, and never exceeds total", async () => {
  const { extra, sent } = fakeExtra("tok");
  const report = makeProgressReporter(extra as never)!;

  report(0.5, "half");
  report(0.5001, "barely moved");
  report(0.9, "most");
  report(0.4, "went backwards");
  report(1, "done");
  await new Promise((resolve) => setImmediate(resolve));

  const values = sent.map((p) => p.progress as number);
  assert.deepEqual(values, [0.5, 0.9, 1], "sub-threshold and backwards steps are dropped");
  for (const params of sent) {
    assert.equal(params.progressToken, "tok");
    assert.equal(params.total, 1);
    assert.ok((params.progress as number) <= 1);
  }
});

test("a failing notification never breaks the caller", () => {
  const extra = {
    _meta: { progressToken: 1 },
    sendNotification: async () => {
      throw new Error("transport closed");
    },
  };
  const report = makeProgressReporter(extra as never)!;
  assert.doesNotThrow(() => report(0.5, "half"));
});

test("run_rolling_window_analysis streams progress when a token is supplied", async () => {
  const client = await connectClient();
  const seen: Progress[] = [];
  const res = await client.callTool(
    {
      name: "run_rolling_window_analysis",
      arguments: { preset: "UPRO", startDate: "1990-01-02", endDate: "2020-01-02", windowLength: 10 },
    },
    undefined,
    { onprogress: (progress) => seen.push(progress) },
  );

  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.ok(seen.length > 0, "expected at least one progress notification");
  for (const [i, progress] of seen.entries()) {
    assert.ok(progress.progress >= 0 && progress.progress <= 1);
    if (i > 0) assert.ok(progress.progress >= seen[i - 1].progress, "progress must not go backwards");
  }
  await client.close();
});

test("compare_strategies streams progress for both the flat and grid modes", async () => {
  const client = await connectClient();
  for (const args of [
    { preset: "UPRO", mode: "sma_on_off" },
    { preset: "UPRO", mode: "asymmetric_buffers", minUpperBuffer: 1, maxUpperBuffer: 2, minLowerBuffer: 1, maxLowerBuffer: 2, gridStep: 1 },
  ]) {
    const seen: Progress[] = [];
    const res = await client.callTool(
      {
        name: "compare_strategies",
        arguments: { ...args, startDate: "1990-01-02", endDate: "2020-01-02", windowLength: 10 },
      },
      undefined,
      { onprogress: (progress) => seen.push(progress) },
    );
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    assert.ok(seen.length > 0, `expected progress for mode ${args.mode}`);
  }
  await client.close();
});

test("run_holding_period_analysis reports one step per holding period", async () => {
  const client = await connectClient();
  const seen: Progress[] = [];
  const res = await client.callTool(
    {
      name: "run_holding_period_analysis",
      arguments: {
        preset: "UPRO",
        startDate: "1990-01-02",
        endDate: "2020-01-02",
        windowLengths: [5, 10, 15],
      },
    },
    undefined,
    { onprogress: (progress) => seen.push(progress) },
  );
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  assert.ok(seen.length > 0);
  assert.equal(seen[seen.length - 1].progress, 1, "the last step should complete the bar");
  await client.close();
});

// Resource templates and argument completion: how a client offers this server's
// vocabulary to a user without them guessing preset or snapshot names.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { ETF_PRESETS } from "@/lib/simulation/presets";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("the preset resource template is advertised", async () => {
  const client = await connectClient();
  const { resourceTemplates } = await client.listResourceTemplates();
  const template = resourceTemplates.find((t) => t.uriTemplate === "letf://preset/{name}");
  assert.ok(template, "letf://preset/{name} is not advertised");
  assert.ok(template?.description);
  await client.close();
});

test("reading a preset resource returns that preset's parameters", async () => {
  const client = await connectClient();
  const res = await client.readResource({ uri: "letf://preset/UPRO" });
  const payload = JSON.parse((res.contents[0] as { text: string }).text) as {
    name: string;
    leverage: number;
    index: string;
    expenseRatio: number;
  };
  assert.equal(payload.name, "UPRO");
  assert.equal(payload.leverage, ETF_PRESETS.UPRO.leverage);
  assert.equal(payload.index, ETF_PRESETS.UPRO.index);
  assert.equal(payload.expenseRatio, ETF_PRESETS.UPRO.expenseRatio);
  await client.close();
});

test("an unknown preset is a clean error, not a crash or an empty document", async () => {
  const client = await connectClient();
  await assert.rejects(() => client.readResource({ uri: "letf://preset/NOPE" }));
  await client.close();
});

test("completing a preset name filters by what has been typed", async () => {
  const client = await connectClient();
  const all = await client.complete({
    ref: { type: "ref/resource", uri: "letf://preset/{name}" },
    argument: { name: "name", value: "" },
  });
  assert.ok(all.completion.values.includes("UPRO"));
  assert.ok(all.completion.values.includes("TQQQ"));

  // The resource serves every preset, so completion offers the -real series too.
  const filtered = await client.complete({
    ref: { type: "ref/resource", uri: "letf://preset/{name}" },
    argument: { name: "name", value: "TQ" },
  });
  assert.deepEqual(filtered.completion.values, ["TQQQ", "TQQQ-real"]);

  const none = await client.complete({
    ref: { type: "ref/resource", uri: "letf://preset/{name}" },
    argument: { name: "name", value: "zzz" },
  });
  assert.deepEqual(none.completion.values, []);
  await client.close();
});

test("preset completion is case-insensitive, since users type lowercase", async () => {
  const client = await connectClient();
  const res = await client.complete({
    ref: { type: "ref/resource", uri: "letf://preset/{name}" },
    argument: { name: "name", value: "upr" },
  });
  assert.deepEqual(res.completion.values, ["UPRO", "UPRO-real"]);
  await client.close();
});

test("the prompt offers only presets its tools accept", async () => {
  // analyze_strategy chains run_backtest, which rejects the real-ETF series, so
  // completing one there would only ever produce a tool error.
  const client = await connectClient();
  const res = await client.complete({
    ref: { type: "ref/prompt", name: "analyze_strategy" },
    argument: { name: "preset", value: "TQ" },
  });
  assert.deepEqual(res.completion.values, ["TQQQ"], "no -real series from the prompt");
  await client.close();
});

test("the analyze_strategy prompt completes its preset argument", async () => {
  const client = await connectClient();
  const res = await client.complete({
    ref: { type: "ref/prompt", name: "analyze_strategy" },
    argument: { name: "preset", value: "U" },
  });
  assert.ok(res.completion.values.includes("UPRO"), "prompt argument offers preset names");
  await client.close();
});

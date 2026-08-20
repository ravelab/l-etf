// CLAUDE.md requires the agent-discovery documents to track `register.ts`. They
// are hand-maintained, so nothing but a test stops them drifting the moment a
// tool is added — and a stale manifest is worse than none, since agents read it
// instead of calling tools/list.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";

async function registeredToolNames(): Promise<string[]> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

test(".well-known/mcp.json advertises exactly the registered tools", async () => {
  const manifest = JSON.parse(readFileSync("public/.well-known/mcp.json", "utf-8")) as {
    capabilities: { tools: Array<{ name: string; description: string }> };
  };
  const advertised = manifest.capabilities.tools.map((t) => t.name).sort();
  assert.deepEqual(advertised, await registeredToolNames());
  for (const tool of manifest.capabilities.tools) {
    assert.ok(tool.description.length > 0, `${tool.name} has no manifest description`);
  }
});

test("llms.txt mentions every registered tool", async () => {
  const llms = readFileSync("public/llms.txt", "utf-8");
  for (const name of await registeredToolNames()) {
    assert.ok(llms.includes(`\`${name}\``), `llms.txt does not mention ${name}`);
  }
});

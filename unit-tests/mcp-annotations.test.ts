// Tool annotations and server instructions are the two things a client reads
// BEFORE deciding whether to call anything: annotations gate auto-approval, and
// instructions are injected into the agent's context once per session. Nothing
// but a test stops a new tool shipping without them.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";

/** Tools that reach a third party rather than only our own data. */
const OPEN_WORLD_TOOLS = new Set(["get_box_spread_apy"]);

async function connectClient(): Promise<Client> {
  const server = new McpServer(
    { name: "l-etf", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAll(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("every tool declares itself read-only and non-destructive", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} has no annotations`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} destructiveHint`);
  }
  await client.close();
});

test("only the third-party tool is marked open-world", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.equal(
      tool.annotations?.openWorldHint,
      OPEN_WORLD_TOOLS.has(tool.name),
      `${tool.name} openWorldHint should be ${OPEN_WORLD_TOOLS.has(tool.name)}`,
    );
  }
  await client.close();
});

test("a tool reaching a live third party is not advertised as idempotent", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  for (const name of OPEN_WORLD_TOOLS) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} is not registered`);
    assert.equal(tool?.annotations?.idempotentHint, false, `${name} idempotentHint`);
  }
  await client.close();
});

test("the server hands the client its usage instructions", async () => {
  const client = await connectClient();
  assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
  await client.close();
});

test("the instructions carry the guidance an agent cannot infer from schemas", async () => {
  // Each of these is a documented sharp edge that has cost real work, so the
  // instructions must keep naming them.
  for (const needle of [
    "get_precomputed_analysis",
    "NOT investment advice",
    "letf://methodology",
    "truncated",
    "progressToken",
  ]) {
    assert.ok(SERVER_INSTRUCTIONS.includes(needle), `instructions omit "${needle}"`);
  }
  // Injected into every session's context, so it has to stay short.
  assert.ok(SERVER_INSTRUCTIONS.length < 2500, "instructions must stay compact");
});

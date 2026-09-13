// A tool that re-runs the engine over every rolling window must be on the
// strict per-IP budget. That classification lives in a hand-maintained Set, so
// nothing but this test stops a new sweep tool shipping on the light budget —
// which is exactly what happened when optimize_strategy was added: the most
// expensive tool on the server landed at 120 calls/minute instead of 20.
//
// Rather than restate the list, this reads the tool sources and asks which ones
// import an engine core that sweeps.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MCP_HEAVY_TOOLS } from "@/lib/mcp/limits";

const TOOLS_DIR = "src/lib/mcp/tools";

/** Modules that run the engine across every rolling window in a range. */
const SWEEPING_CORES = [
  "@/lib/mcp/sweep-core",
  "@/lib/mcp/optimize-core",
  "@/lib/mcp/buffer-grid-core",
  "@/lib/mcp/letf-compare-core",
];

interface ToolSource {
  file: string;
  toolName: string;
  source: string;
}

function readToolSources(): ToolSource[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((file) => {
      const source = readFileSync(join(TOOLS_DIR, file), "utf-8");
      const match = source.match(/registerTool\(\s*"([a-z0-9_]+)"/);
      return match ? [{ file, toolName: match[1], source }] : [];
    });
}

test("every tool source exposes a discoverable tool name", () => {
  const tools = readToolSources();
  assert.ok(tools.length >= 14, `only found ${tools.length} tools`);
  assert.equal(new Set(tools.map((t) => t.toolName)).size, tools.length, "tool names are unique");
});

test("every tool that sweeps rolling windows is on the strict budget", () => {
  const offenders = readToolSources()
    .filter((t) => SWEEPING_CORES.some((core) => t.source.includes(core)))
    .filter((t) => !MCP_HEAVY_TOOLS.has(t.toolName))
    .map((t) => `${t.toolName} (${t.file})`);

  assert.deepEqual(
    offenders,
    [],
    `these tools sweep rolling windows but are on the light budget: ${offenders.join(", ")}`,
  );
});

test("the heavy set names only tools that exist", () => {
  const registered = new Set(readToolSources().map((t) => t.toolName));
  for (const name of MCP_HEAVY_TOOLS) {
    assert.ok(registered.has(name), `MCP_HEAVY_TOOLS names "${name}", which is not registered`);
  }
});

// `optimize_strategy` end-to-end. The point of these is less "does it rank"
// than "does it refuse to hand back a bare winner" — an optimizer over one
// price history is a machine for producing curve-fitted parameters, and the
// guardrails are the feature.

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { MAX_ROLLING_SWEEP_CONFIGS } from "@/lib/mcp/limits";

async function connectClient(): Promise<Client> {
  const server = new McpServer({ name: "l-etf", version: "1.0.0" });
  registerAll(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/** A small grid (2 periods x 2 uppers x 2 lowers = 8 cells) to keep tests quick. */
const SMALL_GRID = {
  preset: "UPRO",
  windowLength: 10,
  startDate: "1950-01-01",
  endDate: "2020-01-01",
  minPeriod: 150,
  maxPeriod: 200,
  periodStep: 50,
  minUpperBuffer: 1,
  maxUpperBuffer: 2,
  minLowerBuffer: 1,
  maxLowerBuffer: 2,
  bufferStep: 1,
};

test("optimize_strategy ranks the grid and names a winner", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "optimize_strategy", arguments: SMALL_GRID });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    gridCells: number;
    best: { smaPeriod: number; upperBuffer: number; lowerBuffer: number; rank: number };
    top: Array<{ rank: number; score: number }>;
  };
  assert.equal(data.gridCells, 8);
  assert.equal(data.best.rank, 1);
  assert.ok([150, 200].includes(data.best.smaPeriod));
  assert.ok([1, 2].includes(data.best.upperBuffer));
  // `top` is ordered best-first and its ranks are consecutive from 1.
  assert.deepEqual(data.top.map((c) => c.rank), data.top.map((_, i) => i + 1));
  for (let i = 1; i < data.top.length; i += 1) {
    assert.ok(data.top[i - 1].score >= data.top[i].score, "top is sorted by score");
  }
  await client.close();
});

test("the result always carries the in-sample caveat", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "optimize_strategy", arguments: SMALL_GRID });
  const data = res.structuredContent as { caveat: string; disclaimer: string };
  assert.match(data.caveat, /in-sample|same history/i);
  assert.ok(data.disclaimer.length > 0);
  await client.close();
});

test("split-sample reports where the winner ranked on history it never saw", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "optimize_strategy", arguments: SMALL_GRID });
  const data = res.structuredContent as {
    gridCells: number;
    search: { startDate: string; endDate: string };
    outOfSample: {
      startDate: string;
      endDate: string;
      winnerRank: number | null;
      ownBest: { smaPeriod: number } | null;
    };
  };
  assert.ok(data.outOfSample, "split sample is on by default");
  // The halves meet and do not overlap, so the search never saw the check half.
  assert.equal(data.search.endDate, data.outOfSample.startDate);
  assert.equal(data.search.startDate, SMALL_GRID.startDate);
  assert.equal(data.outOfSample.endDate, SMALL_GRID.endDate);
  assert.ok(data.outOfSample.winnerRank! >= 1);
  assert.ok(data.outOfSample.winnerRank! <= data.gridCells);
  assert.ok(data.outOfSample.ownBest, "what actually won out of sample is reported");
  await client.close();
});

test("splitSample:false searches the whole range and says the check is missing", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "optimize_strategy",
    arguments: { ...SMALL_GRID, splitSample: false },
  });
  const data = res.structuredContent as {
    search: { startDate: string; endDate: string };
    outOfSample?: unknown;
    caveat: string;
  };
  assert.equal(data.outOfSample, undefined);
  assert.equal(data.search.startDate, SMALL_GRID.startDate);
  assert.equal(data.search.endDate, SMALL_GRID.endDate);
  assert.match(data.caveat, /no split-sample/i);
  await client.close();
});

test("the winner's grid neighbourhood is reported, one step on each axis", async () => {
  const client = await connectClient();
  const res = await client.callTool({ name: "optimize_strategy", arguments: SMALL_GRID });
  const data = res.structuredContent as {
    best: { smaPeriod: number; upperBuffer: number; lowerBuffer: number };
    stability: {
      neighbours: Array<{ smaPeriod: number; upperBuffer: number; lowerBuffer: number }>;
      plateau: boolean;
      worstNeighbourDropPct: number | null;
    };
  };
  // Every axis has 2 values, so any cell is a corner: 3 neighbours.
  assert.equal(data.stability.neighbours.length, 3);
  for (const n of data.stability.neighbours) {
    const changed =
      Number(n.smaPeriod !== data.best.smaPeriod) +
      Number(n.upperBuffer !== data.best.upperBuffer) +
      Number(n.lowerBuffer !== data.best.lowerBuffer);
    assert.equal(changed, 1, "neighbours differ on exactly one axis");
  }
  assert.equal(typeof data.stability.plateau, "boolean");
  assert.ok(data.stability.worstNeighbourDropPct !== null);
  await client.close();
});

test("a grid too wide for one invocation is refused with a way to narrow it", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "optimize_strategy",
    arguments: {
      preset: "UPRO",
      minPeriod: 50,
      maxPeriod: 250,
      periodStep: 5,
      minUpperBuffer: 0,
      maxUpperBuffer: 10,
      minLowerBuffer: 0,
      maxLowerBuffer: 10,
      bufferStep: 0.5,
    },
  });
  assert.equal(res.isError, true);
  const text = (res.content as Array<{ text: string }>)[0].text;
  assert.match(text, new RegExp(String(MAX_ROLLING_SWEEP_CONFIGS)));
  assert.match(text, /Step|step/, "the error says how to narrow the search");
  await client.close();
});

test("the split-sample budget counts both passes, not one", async () => {
  // A grid that fits on its own but not when evaluated twice must be refused
  // while splitSample is on, and accepted once it is off.
  const cellsPerAxis = { minUpperBuffer: 1, maxUpperBuffer: 10, bufferStep: 1 };
  const args = {
    preset: "UPRO",
    windowLength: 10,
    startDate: "1950-01-01",
    endDate: "2020-01-01",
    minPeriod: 100,
    maxPeriod: 250,
    periodStep: 50,
    ...cellsPerAxis,
    minLowerBuffer: 1,
    maxLowerBuffer: 10,
  };
  // 4 periods x 10 uppers x 10 lowers = 400 cells: fits once, not twice.
  const client = await connectClient();
  const split = await client.callTool({ name: "optimize_strategy", arguments: args });
  assert.equal(split.isError, true, "400 cells x 2 passes must be refused");
  assert.match((split.content as Array<{ text: string }>)[0].text, /2 pass/);
  await client.close();
});

test("a range too short to halve is refused rather than silently unchecked", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "optimize_strategy",
    arguments: { ...SMALL_GRID, startDate: "2015-01-01", endDate: "2020-01-01" },
  });
  assert.equal(res.isError, true);
  assert.match((res.content as Array<{ text: string }>)[0].text, /splitSample|years/i);
  await client.close();
});

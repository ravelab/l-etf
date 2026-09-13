import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { runFuturesLadder } from "@/lib/mcp/futures-ladder-core";

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

const RANGE = { startDate: "1990-01-01", endDate: "2020-01-01" };

test("the ladder runs every rung, including the two-sleeve fund", async () => {
  const result = await runFuturesLadder({ showEmulations: false, ...RANGE });
  assert.ok(result.rungs.length >= 4, `only ${result.rungs.length} rungs ran`);

  const dual = result.rungs.filter((r) => r.dualSleeve);
  assert.equal(dual.length, 1, "exactly one rung is the two-sleeve fund");
  assert.ok(dual[0].name.length > 0);

  for (const rung of result.rungs) {
    assert.ok(Number.isFinite(rung.cagrPct), `${rung.name} has no CAGR`);
    assert.ok(rung.maxDrawdownPct > 0, `${rung.name} has no drawdown`);
    assert.ok(rung.futuresTransactions > 0, `${rung.name} never traded a contract`);
  }
});

test("every single-sleeve rung tracks the leverage it was asked for", async () => {
  const result = await runFuturesLadder({ showEmulations: false, ...RANGE });
  for (const rung of result.rungs.filter((r) => !r.dualSleeve)) {
    assert.ok(
      Math.abs(rung.avgActualLeverageRiskOn - rung.targetLeverage) < 0.35,
      `${rung.name}: realized ${rung.avgActualLeverageRiskOn.toFixed(2)} vs target ${rung.targetLeverage}`,
    );
  }
});

test("emulation mode runs only the rungs that have an LETF twin", async () => {
  const [ladder, emulation] = await Promise.all([
    runFuturesLadder({ showEmulations: false, ...RANGE }),
    runFuturesLadder({ showEmulations: true, ...RANGE }),
  ]);
  assert.equal(emulation.emulationMode, true);
  // The twins are 3x and 2x on each index — no 4.5x cap, no dual sleeve.
  assert.equal(emulation.rungs.some((r) => r.dualSleeve), false);
  for (const rung of emulation.rungs) {
    assert.ok([2, 3].includes(rung.targetLeverage), `unexpected twin leverage ${rung.targetLeverage}`);
  }
  assert.notDeepEqual(
    ladder.rungs.map((r) => r.targetLeverage).sort(),
    emulation.rungs.map((r) => r.targetLeverage).sort(),
  );
});

test("best is the highest-CAGR rung", async () => {
  const result = await runFuturesLadder({ showEmulations: false, ...RANGE });
  const max = Math.max(...result.rungs.map((r) => r.cagrPct));
  assert.equal(result.best.cagrPct, max);
});

test("a higher rung carries a deeper drawdown than a lower one on the same index", async () => {
  const result = await runFuturesLadder({ showEmulations: true, ...RANGE });
  const spx = result.rungs.filter((r) => r.index === "sp500" && !r.dualSleeve);
  const three = spx.find((r) => r.targetLeverage === 3)!;
  const two = spx.find((r) => r.targetLeverage === 2)!;
  assert.ok(
    three.maxDrawdownPct > two.maxDrawdownPct,
    `3x drew down ${three.maxDrawdownPct} vs 2x ${two.maxDrawdownPct}`,
  );
});

test("the tool reports the bands it actually used", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "compare_futures_ladder",
    arguments: { ...RANGE, smaPeriodSp: 150, smaUpperBufferSp: 2, smaLowerBufferSp: 5 },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as {
    bands: { sp500: { period: number; upperBuffer: number; lowerBuffer: number } };
    rungs: unknown[];
  };
  assert.deepEqual(data.bands.sp500, { period: 150, upperBuffer: 2, lowerBuffer: 5 });
  assert.ok(data.rungs.length > 0);
  await client.close();
});

test("compare_futures_ladder is registered and advertised", async () => {
  const client = await connectClient();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "compare_futures_ladder");
  assert.ok(tool);
  assert.ok(tool?.outputSchema);
  await client.close();
});

test("a range predating Nasdaq data drops the NDX rungs instead of faking them", async () => {
  // The dual-sleeve fund walks the union of both sleeves' dates, so an NDX
  // sleeve with no data before 1971 would sit frozen at half the equity while
  // the SPX sleeve compounded — reporting a "4.5x SPX 3x NDX" fund that was
  // half dead capital for 86 years, numerically indistinguishable from the
  // plain SPX rung. The ladder must not offer that rung at all.
  const result = await runFuturesLadder({
    showEmulations: false,
    startDate: "1885-03-20",
    endDate: "2020-01-01",
  });
  assert.equal(result.rungs.some((r) => r.dualSleeve), false, "no dual sleeve without NDX data");
  assert.equal(result.rungs.some((r) => r.index === "nasdaq100"), false, "no NDX rungs either");
  assert.ok(result.rungs.length > 0, "the SPX rungs still run");
});

test("a range inside Nasdaq data keeps the NDX rungs", async () => {
  const result = await runFuturesLadder({
    showEmulations: false,
    startDate: "1990-01-01",
    endDate: "2020-01-01",
  });
  assert.ok(result.rungs.some((r) => r.dualSleeve));
  assert.ok(result.rungs.some((r) => r.index === "nasdaq100"));
});

test("the dual-sleeve fund is genuinely distinct from the SPX rung it shares a leverage with", async () => {
  const result = await runFuturesLadder({
    showEmulations: false,
    startDate: "1990-01-01",
    endDate: "2020-01-01",
  });
  const dual = result.rungs.find((r) => r.dualSleeve)!;
  const spxOnly = result.rungs.find((r) => !r.dualSleeve && r.targetLeverage === dual.targetLeverage)!;
  assert.ok(
    Math.abs(dual.cagrPct - spxOnly.cagrPct) > 0.5,
    `dual ${dual.cagrPct.toFixed(2)}% vs SPX-only ${spxOnly.cagrPct.toFixed(2)}% — the NDX sleeve is doing nothing`,
  );
});

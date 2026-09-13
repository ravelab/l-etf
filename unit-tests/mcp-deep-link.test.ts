import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAll } from "@/lib/mcp/register";
import { backtestPermalink, futuresLadderPermalink } from "@/lib/mcp/deep-link";
import { SITE_URL } from "@/lib/seo";

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

const SP_CONFIG = {
  preset: "UPRO",
  startDate: "1990-01-01",
  endDate: "2020-01-01",
  smaPeriod: 200,
  smaUpperBuffer: 2,
  smaLowerBuffer: 3,
  riskOffAsset: "SGOV" as const,
};

test("backtestPermalink builds an absolute URL on this site", () => {
  const url = backtestPermalink(SP_CONFIG);
  assert.ok(url, "a known preset must produce a link");
  assert.ok(url.startsWith(SITE_URL), `${url} should start with ${SITE_URL}`);
  assert.doesNotThrow(() => new URL(url));
});

test("the permalink carries the config the run actually used", () => {
  const params = new URL(backtestPermalink(SP_CONFIG)!).searchParams;
  assert.equal(params.get("letf"), "UPRO");
  assert.equal(params.get("sd"), "1990-01-01");
  assert.equal(params.get("ed"), "2020-01-01");
  assert.equal(params.get("ro"), "SGOV");
  assert.equal(params.get("tab"), "backtest");
  assert.equal(params.get("autorun"), "1", "the link must run, not just prefill");
});

test("SMA params are written on the axis matching the preset's index", () => {
  const sp = new URL(backtestPermalink(SP_CONFIG)!).searchParams;
  assert.equal(sp.get("smaPsp"), "200", "an S&P preset uses the sp keys");
  assert.equal(sp.get("smatspU"), "2");
  assert.equal(sp.get("smatspL"), "3");
  assert.equal(sp.get("smaPnq"), null);

  const nq = new URL(backtestPermalink({ ...SP_CONFIG, preset: "TQQQ" })!).searchParams;
  assert.equal(nq.get("smaPnq"), "200", "a Nasdaq preset uses the nq keys");
  assert.equal(nq.get("smatnqU"), "2");
  assert.equal(nq.get("smatnqL"), "3");
  assert.equal(nq.get("smaPsp"), null);
});

test("backtestPermalink declines rather than guessing for an unknown preset", () => {
  assert.equal(backtestPermalink({ ...SP_CONFIG, preset: "NOT_A_PRESET" }), undefined);
  assert.equal(backtestPermalink({ ...SP_CONFIG, preset: undefined }), undefined);
});

test("run_backtest attaches a permalink when the run came from a preset", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: { preset: "UPRO", smaEnabled: true, startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  const data = res.structuredContent as { permalink?: string };
  assert.ok(data.permalink, "a preset run should link back to the site");
  assert.ok(new URL(data.permalink!).searchParams.get("letf") === "UPRO");
  await client.close();
});

test("run_backtest omits the permalink for a custom config the page cannot reproduce", async () => {
  const client = await connectClient();
  const res = await client.callTool({
    name: "run_backtest",
    arguments: {
      leverage: 2.5,
      index: "sp500",
      startDate: "1990-01-01",
      endDate: "2020-01-01",
    },
  });
  assert.notEqual(res.isError, true, JSON.stringify(res.content));
  const data = res.structuredContent as { permalink?: string };
  assert.equal(data.permalink, undefined, "no link is better than one that runs something else");
  await client.close();
});

const FUTURES_RUN = {
  index: "sp500" as const,
  targetLeverage: 3,
  startDate: "1990-01-01",
  endDate: "2020-01-01",
  smaPeriod: 186,
  smaUpperBuffer: 3.6,
  smaLowerBuffer: 3.6,
  riskOffAsset: "SGOV" as const,
  initialEquity: 100_000,
};

test("futuresLadderPermalink links a leverage that is an actual ladder rung", () => {
  const url = futuresLadderPermalink(FUTURES_RUN);
  assert.ok(url, "3x SPX is a rung, so it must link");
  const params = new URL(url!).searchParams;
  assert.equal(params.get("tab"), "futures");
  assert.equal(params.get("autorun"), "1");
  assert.equal(params.get("sd"), "1990-01-01");
  assert.equal(params.get("ed"), "2020-01-01");
  assert.equal(params.get("ro"), "SGOV");
  assert.equal(params.get("amt"), "100000");
  assert.equal(params.get("smaPsp"), "186");
  assert.equal(params.get("smatspU"), "3.6");
  assert.equal(params.get("smatspL"), "3.6");
});

test("a Nasdaq run writes the nq SMA keys, not the sp ones", () => {
  const params = new URL(
    futuresLadderPermalink({ ...FUTURES_RUN, index: "nasdaq100", smaPeriod: 150 })!,
  ).searchParams;
  assert.equal(params.get("smaPnq"), "150");
  assert.equal(params.get("smaPsp"), null);
});

test("a 2x rung only exists in emulation mode, so the link asks for it", () => {
  const url = futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 2 });
  assert.ok(url, "2x SPX is an emulation rung");
  assert.equal(new URL(url!).searchParams.get("em"), "1");
  // A rung present in the default ladder must not force emulation mode on.
  assert.equal(new URL(futuresLadderPermalink(FUTURES_RUN)!).searchParams.get("em"), null);
});

test("futuresLadderPermalink declines a leverage the ladder does not run", () => {
  // The page has no leverage input: it runs a fixed ladder. A leverage that is
  // not a rung has no row to point at, so a link would open a different run.
  assert.equal(futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 2.7 }), undefined);
  assert.equal(futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 6 }), undefined);
});

test("futuresLadderPermalink declines when maxLeverage disagrees with the rung", () => {
  // The 4.5x rung is capped at 4.5; an uncapped 4.5x run is a different strategy.
  assert.ok(futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 4.5, maxLeverage: 4.5 }));
  assert.equal(futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 4.5 }), undefined);
  assert.equal(
    futuresLadderPermalink({ ...FUTURES_RUN, targetLeverage: 3, maxLeverage: 4 }),
    undefined,
  );
});

test("run_futures_backtest attaches a ladder link only for a rung leverage", async () => {
  const client = await connectClient();
  const onRung = await client.callTool({
    name: "run_futures_backtest",
    arguments: { index: "sp500", targetLeverage: 3, startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  assert.ok((onRung.structuredContent as { permalink?: string }).permalink);

  const offRung = await client.callTool({
    name: "run_futures_backtest",
    arguments: { index: "sp500", targetLeverage: 2.7, startDate: "1990-01-01", endDate: "2020-01-01" },
  });
  assert.notEqual(offRung.isError, true, JSON.stringify(offRung.content));
  assert.equal((offRung.structuredContent as { permalink?: string }).permalink, undefined);
  await client.close();
});

import test from "node:test";
import assert from "node:assert/strict";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { McpToolError } from "@/lib/mcp/tool-result";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";

test("resolves a simulated preset into a config", () => {
  const { config, index, warmUpDays } = resolveBacktest({ preset: "UPRO" });
  assert.equal(config.leverage, 3);
  assert.equal(config.simulated, true);
  assert.equal(config.smaEnabled, false);
  assert.equal(index, "sp500");
  assert.equal(warmUpDays, 0);
});

test("rejects a real-ETF preset", () => {
  assert.throws(() => resolveBacktest({ preset: "UPRO-real" }), McpToolError);
});

test("rejects an unknown preset", () => {
  assert.throws(() => resolveBacktest({ preset: "NOPE" }), McpToolError);
});

test("builds a custom config from leverage + index", () => {
  const { config, index } = resolveBacktest({ leverage: 2, index: "nasdaq100" });
  assert.equal(config.leverage, 2);
  assert.equal(index, "nasdaq100");
  assert.match(config.name, /2x NDX/);
});

test("requires preset or leverage+index", () => {
  assert.throws(() => resolveBacktest({}), McpToolError);
  assert.throws(() => resolveBacktest({ leverage: 3 }), McpToolError);
});

test("SMA enabled sets warm-up to the SMA period and default buffers", () => {
  const { config, warmUpDays } = resolveBacktest({ preset: "TQQQ", smaEnabled: true });
  assert.equal(config.smaEnabled, true);
  assert.equal(config.smaPeriod, getDefaultSmaPeriod("nasdaq100"));
  assert.equal(warmUpDays, config.smaPeriod);
  assert.ok(config.smaUpperBuffer > 0);
});

test("rejects an inverted date range", () => {
  assert.throws(
    () => resolveBacktest({ preset: "UPRO", startDate: "2020-01-01", endDate: "2019-01-01" }),
    McpToolError,
  );
});

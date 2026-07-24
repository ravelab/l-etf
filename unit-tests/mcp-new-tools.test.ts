import test from "node:test";
import assert from "node:assert/strict";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { buildBufferConfigs } from "@/lib/mcp/compare-configs";
import { runRollingSweep } from "@/lib/mcp/sweep-core";
import { runLetfComparison } from "@/lib/mcp/letf-compare-core";
import { runCompareBacktests } from "@/lib/mcp/backtest-compare-core";
import { runFuturesBacktestCore } from "@/lib/mcp/tools/run-futures-backtest";
import { McpToolError } from "@/lib/mcp/tool-result";
import { MAX_BUFFER_STEPS } from "@/lib/mcp/limits";

test("buffer sweep: baseline + one config per buffer, capped", () => {
  const { config } = resolveBacktest({ preset: "UPRO", smaEnabled: true });
  const configs = buildBufferConfigs(config, 0, 5, 1);
  assert.equal(configs.length, 7); // baseline + 0..5
  assert.equal(configs[0].smaEnabled, false);
  assert.throws(() => buildBufferConfigs(config, 0, 30, 0.1), McpToolError);
  assert.ok(MAX_BUFFER_STEPS > 0);
});

test("compare_letfs: percentile stats per simulated preset", async () => {
  const rows = await runLetfComparison({
    presets: ["UPRO", "SSO", "TQQQ", "QLD"],
    smaEnabled: false,
    windowLength: 10,
    startDate: "1990-01-01",
    endDate: "2020-01-02",
  });
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(r.windows > 0);
    assert.ok(r.cagrPct.p10 <= r.cagrPct.p50 && r.cagrPct.p50 <= r.cagrPct.p90, "percentiles ordered");
    assert.ok(r.winRatePct >= 0 && r.winRatePct <= 100);
  }
  // Sorted by median CAGR, descending.
  assert.ok(rows[0].cagrPct.p50 >= rows[rows.length - 1].cagrPct.p50);
});

test("compare_letfs rejects real-ETF presets", async () => {
  await assert.rejects(
    () => runLetfComparison({ presets: ["UPRO-real"], smaEnabled: false, windowLength: 10 }),
    McpToolError,
  );
});

test("compare_backtests: simulated tracks real UPRO closely", async () => {
  const rows = await runCompareBacktests({
    presets: ["UPRO", "UPRO-real"],
    smaEnabled: false,
    startDate: "2010-01-04",
    endDate: "2020-01-02",
  });
  assert.equal(rows.length, 2);
  const sim = rows.find((r) => r.name === "UPRO")!;
  const real = rows.find((r) => r.name === "UPRO-real")!;
  assert.ok(sim && real);
  // Calibration goal: the simulated series should track the real ETF within ~10%.
  assert.ok(
    Math.abs(sim.finalMultiple - real.finalMultiple) / real.finalMultiple < 0.1,
    `sim ${sim.finalMultiple} vs real ${real.finalMultiple}`,
  );
});

test("compare_backtests spans both indexes in one call", async () => {
  const rows = await runCompareBacktests({
    presets: ["UPRO", "TQQQ"],
    smaEnabled: false,
    startDate: "2010-01-04",
    endDate: "2020-01-02",
  });
  assert.deepEqual(
    rows.map((r) => r.index).sort(),
    ["nasdaq100", "sp500"],
  );
});

test("run_futures_backtest: 3x futures realizes target leverage", async () => {
  const out = await runFuturesBacktestCore({
    index: "sp500",
    targetLeverage: 3,
    startDate: "2005-01-03",
    endDate: "2020-01-02",
  });
  assert.ok(out.finalEquity > out.initialEquity);
  assert.ok(Number.isFinite(out.cagrPct));
  assert.ok(out.futuresTransactions > 0);
  assert.ok(Math.abs(out.avgActualLeverageRiskOn - 3) < 0.3, "avg leverage near target");
});

test("holding-period sweep returns per-length stats", async () => {
  const { config, index, startDate, endDate } = resolveBacktest({ preset: "UPRO", smaEnabled: true });
  const lengths = [3, 10, 20];
  const rows = await Promise.all(
    lengths.map((wl) => runRollingSweep({ index, configs: [config], windowLength: wl, startDate, endDate })),
  );
  for (const r of rows) {
    assert.equal(r.length, 1);
    assert.ok(Number.isFinite(r[0].stats.avgReturn));
  }
});

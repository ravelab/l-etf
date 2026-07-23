import test from "node:test";
import assert from "node:assert/strict";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import {
  buildRiskOffConfigs,
  buildSmaOnOffConfigs,
  buildSmaPeriodConfigs,
} from "@/lib/mcp/compare-configs";
import { McpToolError } from "@/lib/mcp/tool-result";
import { runRollingSweep } from "@/lib/mcp/sweep-core";
import { MAX_SMA_PERIOD_STEPS } from "@/lib/mcp/limits";

function baseConfig() {
  return resolveBacktest({ preset: "UPRO", smaEnabled: true });
}

test("sma_on_off builds a baseline and an SMA variant", () => {
  const { config } = baseConfig();
  const configs = buildSmaOnOffConfigs(config);
  assert.equal(configs.length, 2);
  assert.equal(configs[0].smaEnabled, false);
  assert.equal(configs[1].smaEnabled, true);
  assert.equal(new Set(configs.map((c) => c.id)).size, 2, "unique ids");
});

test("risk_off_assets builds one SMA variant per asset plus a trailing baseline", () => {
  const { config } = baseConfig();
  const configs = buildRiskOffConfigs(config, ["SGOV", "GLDM"]);
  assert.equal(configs.length, 3);
  // Shared builder order: variants first, no-SMA baseline last.
  assert.equal(configs[configs.length - 1].smaEnabled, false);
  assert.deepEqual(
    configs.slice(0, -1).map((c) => c.riskOffAsset),
    ["SGOV", "GLDM"],
  );
});

test("sma_periods enforces the step-count limit", () => {
  const { config } = baseConfig();
  assert.throws(() => buildSmaPeriodConfigs(config, 5, 500, 1), McpToolError);
  const ok = buildSmaPeriodConfigs(config, 50, 200, 50);
  assert.ok(ok.length - 1 <= MAX_SMA_PERIOD_STEPS);
  assert.equal(ok[0].smaEnabled, false);
});

test("rolling sweep returns aggregate stats for each config", async () => {
  const { config, index, startDate, endDate } = baseConfig();
  const configs = buildSmaOnOffConfigs(config);
  const rows = await runRollingSweep({ index, configs, windowLength: 10, startDate, endDate });
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(Number.isFinite(r.stats.avgReturn));
    assert.ok(Number.isFinite(r.stats.avgMaxDrawdown));
    assert.ok((r.stats.avgWindowYears ?? 0) > 0);
  }
  // The SMA variant should cut the worst drawdown vs buy-and-hold.
  const baseline = rows.find((r) => r.id === "baseline");
  const sma = rows.find((r) => r.id === "sma");
  assert.ok(baseline && sma);
  assert.ok(
    Math.abs(sma!.stats.biggestMaxDrawdown) < Math.abs(baseline!.stats.biggestMaxDrawdown),
    "SMA reduces the worst-case drawdown",
  );
});

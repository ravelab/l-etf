import assert from "node:assert/strict";
import test from "node:test";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { runSignalRule, withSignalRuleLines } from "@/lib/simulation/signal-rules";
import { NDX_TREND_SHIELD_RULE as rule } from "@/lib/simulation/trend-shield";

test("Trend & Shield adds an NDX-only line with fixed VGSH", () => {
  const upro = createPresetEtfConfig("etf1", ETF_PRESETS.UPRO, { smaEnabled: true });
  const tqqq = createPresetEtfConfig("etf2", ETF_PRESETS.TQQQ, { smaEnabled: true, riskOffAsset: "SGOV" });
  const configs = withSignalRuleLines([upro, tqqq], [rule.id]);
  assert.equal(configs.length, 3);
  assert.equal(configs[1].riskOffAsset, "SGOV");
  assert.equal(configs[2].smaIndex, "nasdaq100");
  assert.equal(configs[2].riskOffAsset, "VGSH");
});

test("Trend & Shield takes an oversold bounce, stops out, and shields a volatility spike", () => {
  const closes = [...Array<number>(150).fill(100), 96, 95, 93, 108, 125];
  const dates = closes.map((_, i) => new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10));
  const line = { smaIndex: "nasdaq100", smaPeriod: 139, smaUpperBuffer: 9, smaLowerBuffer: 17 } as const;
  const { invested, smaValues } = runSignalRule(rule, dates, closes, line);
  assert.equal(smaValues[149], 100);
  assert.deepEqual(invested.slice(149), [true, false, true, false, false, false]);
});

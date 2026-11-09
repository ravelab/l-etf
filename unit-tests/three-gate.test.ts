import test from "node:test";
import assert from "node:assert/strict";
import {
  NDX_THREE_GATE_RULE,
  THREE_GATE_PARAMS,
  computeThreeGateVerdict,
  confirmThreeGateRegime,
  nextDrawdownGateOut,
} from "@/lib/simulation/three-gate";
import { runSignalRule, withSignalRuleLines } from "@/lib/simulation/signal-rules";
import { computeRealizedVol } from "@/lib/simulation/vol-gate";
import { simulateBacktest } from "@/lib/simulation/engine";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";

function isoDates(count: number): string[] {
  const start = Date.UTC(2000, 0, 3);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** Price path from per-day (drift, noise) segments; noise alternates sign each day. */
function path(segments: Array<{ days: number; drift: number; noise: number }>): number[] {
  const prices = [100];
  let k = 0;
  for (const { days, drift, noise } of segments) {
    for (let d = 0; d < days; d++, k++) {
      prices.push(prices[prices.length - 1] * (1 + drift + (k % 2 === 0 ? noise : -noise)));
    }
  }
  return prices;
}

const CALM = { drift: 0.0005, noise: 0.005 };
const LINE = { smaIndex: "nasdaq100", smaPeriod: 136, smaUpperBuffer: 9.6, smaLowerBuffer: 17.9 } as const;
const DIP_AND_RECOVER = [
  { days: 300, ...CALM },
  { days: 110, drift: -0.0025, noise: 0.004 },
  { days: 200, drift: 0.0025, noise: 0.004 },
];

test("no verdict until a full baseline window exists", () => {
  const closes = path([{ days: 400, ...CALM }]);
  const verdict = computeThreeGateVerdict(closes);
  for (let i = 0; i < THREE_GATE_PARAMS.baselineWindowDays; i++) assert.equal(verdict[i], false, `index ${i}`);
  assert.ok(verdict.slice(THREE_GATE_PARAMS.baselineWindowDays).every(Boolean), "a calm uptrend passes every gate");
});

test("absolute volatility gate: steady 40% vol fails even with no shock and no drawdown", () => {
  const closes = path([{ days: 400, drift: 0.0003, noise: 0.025 }]);
  assert.ok(computeRealizedVol(closes, THREE_GATE_PARAMS.volWindowDays)[350] > THREE_GATE_PARAMS.volBelow);
  const verdict = computeThreeGateVerdict(closes);
  assert.ok(verdict.slice(THREE_GATE_PARAMS.baselineWindowDays + 1).every((v) => !v));
});

test("volatility shock gate: 20d vol well above its 250d baseline fails while still under 35%", () => {
  const calmDays = 300;
  const closes = path([{ days: calmDays, ...CALM }, { days: 30, drift: 0.0005, noise: 0.012 }]);
  const short = computeRealizedVol(closes, THREE_GATE_PARAMS.volWindowDays);
  const base = computeRealizedVol(closes, THREE_GATE_PARAMS.baselineWindowDays);
  const i = calmDays + 25;
  assert.ok(short[i] < THREE_GATE_PARAMS.volBelow, "below the absolute ceiling");
  assert.ok(short[i] / base[i] > THREE_GATE_PARAMS.shockBelow, "but a shock against the baseline");
  const verdict = computeThreeGateVerdict(closes);
  assert.equal(verdict[calmDays - 1], true);
  assert.equal(verdict[i], false);
});

test("drawdown gate exits below -20% and re-enters only above -10%", () => {
  const p = THREE_GATE_PARAMS;
  assert.equal(nextDrawdownGateOut(false, -0.19, p), false);
  assert.equal(nextDrawdownGateOut(false, -0.21, p), true);
  assert.equal(nextDrawdownGateOut(true, -0.15, p), true, "inside the band stays out");
  assert.equal(nextDrawdownGateOut(true, -0.09, p), false);
  assert.equal(nextDrawdownGateOut(false, -0.15, p), false, "inside the band stays in");
  assert.equal(nextDrawdownGateOut(true, Number.NaN, p), true, "NaN keeps the state");
});

test("drawdown gate on a path: out through the recovery until within 10% of the high", () => {
  const closes = path(DIP_AND_RECOVER);
  const verdict = computeThreeGateVerdict(closes);
  const high = (i: number) => Math.max(...closes.slice(Math.max(0, i - THREE_GATE_PARAMS.highWindowDays + 1), i + 1));
  const dd = closes.map((c, i) => c / high(i) - 1);
  const firstExit = dd.findIndex((d, i) => i > 300 && d < -THREE_GATE_PARAMS.exitDrawdown);
  assert.ok(firstExit > 0);
  assert.equal(verdict[firstExit - 1], true);
  assert.equal(verdict[firstExit], false);
  const trough = closes.indexOf(Math.min(...closes.slice(300)));
  assert.equal(verdict[dd.findIndex((d, i) => i > trough && d > -0.15)], false, "back above -20% is not enough");
  assert.equal(verdict[dd.findIndex((d, i) => i > trough && d > -THREE_GATE_PARAMS.reenterDrawdown)], true);
});

test("the position changes only after the verdict holds for two sessions", () => {
  const verdict = [false, true, false, true, true, true, false, true, false, false, false];
  assert.deepEqual(
    confirmThreeGateRegime(verdict, 2),
    [false, false, false, false, true, true, true, true, true, false, false]
  );
  assert.deepEqual(confirmThreeGateRegime(verdict, 1), verdict);
});

test("the rule's regime is the confirmed verdict, and it warms up for its longest window", () => {
  const closes = path(DIP_AND_RECOVER);
  const dates = isoDates(closes.length);
  assert.deepEqual(
    NDX_THREE_GATE_RULE.regime(dates, closes, LINE),
    confirmThreeGateRegime(computeThreeGateVerdict(closes), THREE_GATE_PARAMS.confirmDays)
  );
  assert.equal(NDX_THREE_GATE_RULE.warmUpDays, 252);
  assert.deepEqual(runSignalRule(NDX_THREE_GATE_RULE, dates, closes, LINE).signals.map((s) => s.type), ["buy", "sell", "buy"]);
});

test("ticked on a UPRO+TQQQ run, it adds one TQQQ 3-Gate line on the TQQQ line's risk-off", () => {
  const upro = createPresetEtfConfig("etf1", ETF_PRESETS.UPRO, { smaEnabled: true, riskOffAsset: "BRK.B+GLDM" });
  const tqqq = createPresetEtfConfig("etf2", ETF_PRESETS.TQQQ, {
    smaEnabled: true, smaPeriod: 136, smaUpperBuffer: 9.6, smaLowerBuffer: 17.9, smaVolGate: true, riskOffAsset: "VGSH",
  });
  const configs = withSignalRuleLines([upro, tqqq], [NDX_THREE_GATE_RULE.id]);
  assert.equal(configs.length, 3);
  assert.equal(configs[2].signalRule, "ndx-3-gate");
  assert.equal(configs[2].riskOffAsset, "VGSH");

  const closes = path(DIP_AND_RECOVER);
  const dates = isoDates(closes.length);
  const vgsh = closes.map(() => 100);
  const result = simulateBacktest(
    closes.map((close, i) => ({ date: dates[i], adj_close: close, close, open: close, adj_open: close })),
    [{ date: dates[0], rateType: "borrow", rateValue: 0.02 }],
    configs.slice(1),
    { riskOffValuesByAsset: { VGSH: vgsh }, riskOffOpenValuesByAsset: { VGSH: vgsh } }
  );
  const line = findEtfResult(result, "etf3-sma");
  assert.equal(line?.name, "TQQQ (3-Gate, VGSH)");
  assert.equal(shortBacktestAssetLabel(line!.name), "TQQQ 3-Gate");
  assert.deepEqual(line?.smaSignals, runSignalRule(NDX_THREE_GATE_RULE, dates, closes, LINE).signals);
});

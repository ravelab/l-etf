import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_VOL_SHOCK_STATE,
  NDX_VOL_SHOCK_GATE,
  computeVolShockRatio,
  nextVolShockState,
  type VolShockGateParams,
} from "@/lib/simulation/vol-shock-gate";
import { NDX_SMA_VOL_SHOCK_RULE } from "@/lib/simulation/sma-vol-shock";
import { getSignalRule, lineWarmUpDays, runSignalRule } from "@/lib/simulation/signal-rules";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { buildSmaTradeRows } from "@/lib/sma-trade-rows";

const GATE: VolShockGateParams = { windowDays: 20, baselineDays: 375, exitAbove: 1.2, reenterBelow: 0.9, confirmDays: 2 };
const LINE = { smaIndex: "nasdaq100", smaPeriod: 50, smaUpperBuffer: 2, smaLowerBuffer: 10 } as const;

function isoDates(count: number): string[] {
  const start = Date.UTC(2000, 0, 3);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** A long calm uptrend (~8% vol), 20 days at ~24% vol still trending up, then calm again. */
function path(): number[] {
  const out = [100];
  const push = (r: number) => out.push(out[out.length - 1] * (1 + r));
  for (let i = 0; i < 450; i++) push(0.001 + (i % 2 ? -0.005 : 0.005));
  for (let i = 0; i < 20; i++) push(0.002 + (i % 2 ? -0.015 : 0.015));
  for (let i = 0; i < 60; i++) push(0.001 + (i % 2 ? -0.005 : 0.005));
  return out;
}

function step(ratios: number[], gate = GATE): boolean[] {
  let state = INITIAL_VOL_SHOCK_STATE;
  return ratios.map((r) => (state = nextVolShockState(state, r, gate)).riskOff);
}

test("trips at the exit ratio only after the confirmation closes, and releases below the re-entry ratio", () => {
  assert.deepEqual(step([1.0, 1.2, 1.3, 1.1, 0.95, 0.89, 0.8]), [false, false, true, true, true, true, false]);
});

test("a reading that reverts inside the confirmation window never moves the position", () => {
  assert.deepEqual(step([1.25, 0.85, 1.0]), [false, false, false]);
});

test("a NaN ratio keeps the raw reading, so confirmation still completes", () => {
  assert.deepEqual(step([1.3, Number.NaN, 0.5]), [false, true, true]);
});

test("confirmDays 1 acts on the same close", () => {
  assert.deepEqual(step([1.2, 0.85], { ...GATE, confirmDays: 1 }), [true, false]);
});

test("the ratio is undefined until the baseline window is full", () => {
  const ratio = computeVolShockRatio(path(), GATE);
  assert.ok(Number.isNaN(ratio[GATE.baselineDays - 1]));
  assert.ok(Number.isFinite(ratio[GATE.baselineDays]));
});

test("added to SMA + vol + RSI, a calm-to-violent spike forces a shock exit and re-entry", () => {
  const closes = path();
  const dates = isoDates(closes.length);
  const band = { upper: LINE.smaUpperBuffer, lower: LINE.smaLowerBuffer };
  const base = generateSmaSignals(dates, closes, LINE.smaPeriod, band, smaRiskOffGates("nasdaq100"));
  const shocked = generateSmaSignals(dates, closes, LINE.smaPeriod, band, { ...smaRiskOffGates("nasdaq100"), shockGate: GATE });
  assert.ok(base.invested.slice(1).every(Boolean), "~24% vol trips neither the 50% vol gate nor the band");
  assert.deepEqual(shocked.signals.map((s) => [s.type, s.trigger]), [["sell", "shock"], ["buy", "shock"]]);
  const exit = dates.indexOf(shocked.signals[0].date);
  assert.ok(exit > 451 && exit < 470, "exits during the spike");
});

test("registered as the NDX rule with the chosen gate, keeping its triggers", () => {
  assert.equal(getSignalRule("ndx-sma-vol-shock"), NDX_SMA_VOL_SHOCK_RULE);
  assert.deepEqual(NDX_SMA_VOL_SHOCK_RULE.indices, ["nasdaq100"]);
  assert.deepEqual(NDX_VOL_SHOCK_GATE, GATE);
  assert.equal(lineWarmUpDays({ smaEnabled: true, smaPeriod: 136, signalRule: NDX_SMA_VOL_SHOCK_RULE.id }), 378);

  const closes = path();
  const dates = isoDates(closes.length);
  const run = runSignalRule(NDX_SMA_VOL_SHOCK_RULE, dates, closes, LINE);
  assert.deepEqual(run.signals.map((s) => s.trigger), ["shock", "shock"]);
  const flips = run.invested.flatMap((v, i) => (i > 0 && v !== run.invested[i - 1] ? [dates[i]] : []));
  assert.deepEqual(run.signals.map((s) => s.date), flips, "signals are the regime's changes");
});

test("the trade table reports the shock ratio at the trigger close", () => {
  const closes = path();
  const dates = isoDates(closes.length);
  const run = runSignalRule(NDX_SMA_VOL_SHOCK_RULE, dates, closes, LINE);
  const rows = buildSmaTradeRows({
    etf: { smaSignals: run.signals, smaPrices: run.smaValues, smaStartInvested: true },
    config: { name: "TQQQ", riskOffAsset: "VGSH", smaExecutionMode: "next-day-open", smaIndex: "nasdaq100" },
    etfDates: dates,
    closePrices: closes,
    openPrices: closes,
    tradeClosePrices: closes,
    tradeOpenPrices: closes,
    syntheticPriceScale: 1,
    annualizedInflation: 0,
  });
  const shockRows = rows.filter((row) => row.trigger === "shock");
  const ratio = computeVolShockRatio(closes, GATE);
  assert.equal(shockRows.length, 2);
  assert.equal(shockRows[0].triggerShock, ratio[dates.indexOf(shockRows[0].signalDate)]);
  assert.ok(shockRows[0].triggerShock! >= GATE.exitAbove);
  assert.ok(shockRows[1].triggerShock! < GATE.reenterBelow);
});

test("its line is named like the default SMA Vol RSI line, plus Shock", () => {
  assert.equal(NDX_SMA_VOL_SHOCK_RULE.label, "SMA Vol RSI Shock");
});

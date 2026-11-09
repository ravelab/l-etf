import test from "node:test";
import assert from "node:assert/strict";
import { NDX_ARGMAX_VOL_GATE, NDX_SMA_VOL_ARGMAX_RULE } from "@/lib/simulation/sma-vol-argmax";
import { getSignalRule, lineWarmUpDays, runSignalRule, withSignalRuleLines } from "@/lib/simulation/signal-rules";
import { computeSma, generateSmaSignals } from "@/lib/simulation/sma";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { SMA_RSI_BRAKE } from "@/lib/simulation/rsi-brake";
import { simulateBacktest } from "@/lib/simulation/engine";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";

const LINE = { smaIndex: "nasdaq100", smaPeriod: 50, smaUpperBuffer: 2, smaLowerBuffer: 10 } as const;

function isoDates(count: number): string[] {
  const start = Date.UTC(2000, 0, 3);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** Calm uptrend, a ~48%-vol stretch that still trends up, then calm again. */
function path(): number[] {
  const out = [100];
  const push = (r: number) => out.push(out[out.length - 1] * (1 + r));
  for (let i = 0; i < 200; i++) push(0.001 + (i % 2 ? -0.005 : 0.005));
  for (let i = 0; i < 20; i++) push(0.003 + (i % 2 ? -0.029 : 0.029));
  for (let i = 0; i < 80; i++) push(0.001 + (i % 2 ? -0.005 : 0.005));
  return out;
}

test("registered as the NDX-only 9d 46%/40% gate", () => {
  assert.equal(getSignalRule("ndx-sma-vol-9d"), NDX_SMA_VOL_ARGMAX_RULE);
  assert.deepEqual(NDX_SMA_VOL_ARGMAX_RULE.indices, ["nasdaq100"]);
  assert.deepEqual(NDX_ARGMAX_VOL_GATE, { windowDays: 9, exitAbove: 0.46, reenterBelow: 0.4 });
});

test("it is the line's own SMA band and RSI brake with only the vol gate swapped", () => {
  const closes = path();
  const dates = isoDates(closes.length);
  const band = { upper: LINE.smaUpperBuffer, lower: LINE.smaLowerBuffer };
  const regime = NDX_SMA_VOL_ARGMAX_RULE.regime(dates, closes, LINE);
  assert.deepEqual(
    regime,
    generateSmaSignals(dates, closes, LINE.smaPeriod, band, { volGate: NDX_ARGMAX_VOL_GATE, rsiBrake: SMA_RSI_BRAKE.nasdaq100 }).invested
  );
  const shipped = generateSmaSignals(dates, closes, LINE.smaPeriod, band, smaRiskOffGates("nasdaq100")).invested;
  assert.ok(shipped.slice(200).every(Boolean), "~48% vol never trips the shipped 50% exit");
  assert.ok(regime.slice(200).some((v) => !v), "but trips the 46% exit");
});

test("it charts the band's SMA and warms up for the band's period", () => {
  const closes = path();
  const dates = isoDates(closes.length);
  assert.deepEqual(runSignalRule(NDX_SMA_VOL_ARGMAX_RULE, dates, closes, LINE).smaValues, computeSma(closes, LINE.smaPeriod));
  assert.equal(lineWarmUpDays({ smaEnabled: true, smaPeriod: 136, signalRule: NDX_SMA_VOL_ARGMAX_RULE.id }), 136);
});

test("ticked, it adds a TQQQ SMA Vol 9d line beside TQQQ SMA Vol RSI", () => {
  const tqqq = createPresetEtfConfig("etf1", ETF_PRESETS.TQQQ, {
    smaEnabled: true, smaPeriod: LINE.smaPeriod, smaUpperBuffer: LINE.smaUpperBuffer, smaLowerBuffer: LINE.smaLowerBuffer,
    smaVolGate: true, riskOffAsset: "VGSH",
  });
  const closes = path();
  const dates = isoDates(closes.length);
  const vgsh = closes.map(() => 100);
  const result = simulateBacktest(
    closes.map((close, i) => ({ date: dates[i], adj_close: close, close, open: close, adj_open: close })),
    [{ date: dates[0], rateType: "borrow", rateValue: 0.02 }],
    withSignalRuleLines([tqqq], [NDX_SMA_VOL_ARGMAX_RULE.id]),
    { riskOffValuesByAsset: { VGSH: vgsh }, riskOffOpenValuesByAsset: { VGSH: vgsh } }
  );
  const shipped = findEtfResult(result, "etf1-sma");
  const argmax = findEtfResult(result, "etf2-sma");
  assert.equal(shipped?.name, "TQQQ (SMA Vol RSI, VGSH)");
  assert.equal(argmax?.name, "TQQQ (SMA Vol 9d, VGSH)");
  assert.equal(shortBacktestAssetLabel(argmax!.name), "TQQQ SMA Vol 9d");
  assert.deepEqual(argmax?.smaPrices, shipped?.smaPrices, "same SMA line on the details chart");
  assert.notDeepEqual(argmax?.smaSignals, shipped?.smaSignals);
});

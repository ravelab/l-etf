import test from "node:test";
import assert from "node:assert/strict";
import { computeRealizedVol, computeVolGateRiskOff, nextVolGateRiskOff, SMA_VOL_GATE } from "@/lib/simulation/vol-gate";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { getSmaSignal } from "@/lib/sma-signals";
import type { DailyPrice } from "@/lib/data/storage/types";

function isoDates(count: number): string[] {
  const start = Date.UTC(2020, 0, 1);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/**
 * Calm uptrend, then a turbulent stretch that still trends up (so the SMA alone
 * never exits), then calm again.
 */
function calmStormCalm(): { prices: number[]; stormStart: number; stormEnd: number } {
  const prices = [100];
  const push = (r: number) => prices.push(prices[prices.length - 1] * (1 + r));
  for (let i = 0; i < 80; i++) push(0.003);
  const stormStart = prices.length;
  for (let i = 0; i < 20; i++) push(i % 2 === 0 ? 0.06 : -0.02);
  const stormEnd = prices.length;
  for (let i = 0; i < 40; i++) push(0.003);
  return { prices, stormStart, stormEnd };
}

test("computeRealizedVol is NaN until a full window and annualizes by sqrt(252)", () => {
  const prices = [100];
  for (let i = 0; i < 30; i++) prices.push(prices[i] * (i % 2 === 0 ? 1.01 : 0.99));
  const vol = computeRealizedVol(prices);
  for (let i = 0; i < SMA_VOL_GATE.windowDays; i++) assert.ok(Number.isNaN(vol[i]), `index ${i}`);

  const i = 20;
  const r: number[] = [];
  for (let k = i - SMA_VOL_GATE.windowDays + 1; k <= i; k++) r.push(Math.log(prices[k] / prices[k - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  assert.ok(Math.abs(vol[i] - Math.sqrt(variance * 252)) < 1e-12);
});

test("computeRealizedVol of a constant-return series is zero", () => {
  const prices = [100];
  for (let i = 0; i < 20; i++) prices.push(prices[i] * 1.01);
  const vol = computeRealizedVol(prices);
  assert.ok(Math.abs(vol[15]) < 1e-9);
});

test("nextVolGateRiskOff trips above the exit level and releases only below the re-entry level", () => {
  assert.equal(nextVolGateRiskOff(false, 0.45), false);
  assert.equal(nextVolGateRiskOff(false, 0.51), true);
  assert.equal(nextVolGateRiskOff(true, 0.4), true);
  assert.equal(nextVolGateRiskOff(true, 0.32), true);
  assert.equal(nextVolGateRiskOff(true, 0.3), false);
  assert.equal(nextVolGateRiskOff(true, NaN), true);
  assert.equal(nextVolGateRiskOff(false, NaN), false);
});

test("the gate trips during the storm and releases after it", () => {
  const { prices, stormStart, stormEnd } = calmStormCalm();
  const gate = computeVolGateRiskOff(prices);
  assert.equal(gate[stormStart - 1], false);
  assert.equal(gate[stormEnd - 1], true);
  assert.equal(gate[gate.length - 1], false);
});

test("generateSmaSignals without the gate rides through the storm", () => {
  const { prices } = calmStormCalm();
  const { signals, invested } = generateSmaSignals(isoDates(prices.length), prices, 20, { upper: 0, lower: 0 });
  assert.equal(signals.filter((s) => s.type === "sell").length, 0);
  assert.ok(invested.every(Boolean));
});

test("a gated run labels an SMA crossing as an SMA trigger", () => {
  const prices = [100];
  for (let i = 0; i < 60; i++) prices.push(prices[i] * 1.003);
  for (let i = 0; i < 30; i++) prices.push(prices[prices.length - 1] * 0.995);
  const gated = generateSmaSignals(isoDates(prices.length), prices, 20, { upper: 0, lower: 0 }, { volGate: true });
  assert.deepEqual(gated.signals.map((s) => [s.type, s.trigger]), [["sell", "sma"]]);
  const plain = generateSmaSignals(isoDates(prices.length), prices, 20, { upper: 0, lower: 0 });
  assert.equal(plain.signals[0]!.trigger, undefined);
});

test("generateSmaSignals with the gate sells into the storm and buys back once calm", () => {
  const { prices, stormStart, stormEnd } = calmStormCalm();
  const dates = isoDates(prices.length);
  const { signals, invested } = generateSmaSignals(dates, prices, 20, { upper: 0, lower: 0 }, { volGate: true });
  assert.deepEqual(signals.map((s) => s.type), ["sell", "buy"]);
  assert.deepEqual(signals.map((s) => s.trigger), ["vol", "vol"]);
  const sellIdx = dates.indexOf(signals[0]!.date);
  const buyIdx = dates.indexOf(signals[1]!.date);
  assert.ok(sellIdx >= stormStart && sellIdx < stormEnd);
  assert.ok(buyIdx >= stormEnd);
  assert.equal(invested[stormEnd - 1], false);
  assert.equal(invested[invested.length - 1], true);
});

test("the gate never buys while the SMA says risk-off", () => {
  const prices = [100];
  for (let i = 0; i < 60; i++) prices.push(prices[i] * 1.003);
  for (let i = 0; i < 40; i++) prices.push(prices[prices.length - 1] * (i % 2 === 0 ? 0.94 : 1.01));
  for (let i = 0; i < 40; i++) prices.push(prices[prices.length - 1] * 0.999);
  const { invested } = generateSmaSignals(isoDates(prices.length), prices, 20, { upper: 0, lower: 0 }, { volGate: true });
  assert.equal(invested[invested.length - 1], false);
});

test("getSmaSignal reports a tripped gate as a sell only when the gate is requested", () => {
  const { prices, stormEnd } = calmStormCalm();
  const daily: DailyPrice[] = prices.slice(0, stormEnd).map((close, i) => ({
    date: isoDates(prices.length)[i]!,
    name: "SPX",
    close,
    source: "test",
  }));

  const plain = getSmaSignal(daily, 20, { upper: 0, lower: 0 });
  assert.notEqual(plain.signal, "sell");
  assert.equal(plain.volatility, undefined);

  const gated = getSmaSignal(daily, 20, { upper: 0, lower: 0 }, { volGate: true });
  assert.equal(gated.signal, "sell");
  assert.equal(gated.signalLabel, "Volatility Risk Off");
  assert.equal(gated.volGateRiskOff, true);
  assert.ok((gated.volatility ?? 0) > SMA_VOL_GATE.reenterBelow);
});

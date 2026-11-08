import test from "node:test";
import assert from "node:assert/strict";
import {
  SMA_RSI_BRAKE,
  computeRsiBrakeRiskOff,
  computeWilderRsi,
  nextRsiBrakeRiskOff,
  rsiBrakeParamsTextFor,
} from "@/lib/simulation/rsi-brake";
import { smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
import { SMA_VOL_GATE } from "@/lib/simulation/vol-gate";
import { generateSmaSignals } from "@/lib/simulation/sma";
import { getSmaSignal } from "@/lib/sma-signals";
import { computeSmaSignalSnapshot, getDefaultSmaSignalConfig } from "@/lib/sma-status";
import { summarizeSignalHistory } from "@/lib/mcp/signal-history-core";
import type { DailyPrice } from "@/lib/data/storage/types";

const BRAKE = SMA_RSI_BRAKE.sp500;

function isoDates(count: number): string[] {
  const start = Date.UTC(2020, 0, 1);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

/** Textbook Wilder RSI, written independently of the implementation under test. */
function referenceRsi(prices: number[], n: number): number[] {
  const out = prices.map(() => NaN);
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  if (changes.length < n) return out;
  let gain = changes.slice(0, n).filter((c) => c > 0).reduce((a, b) => a + b, 0) / n;
  let loss = -changes.slice(0, n).filter((c) => c < 0).reduce((a, b) => a + b, 0) / n;
  const rsi = (g: number, l: number) => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[n] = rsi(gain, loss);
  for (let i = n; i < changes.length; i++) {
    gain = (gain * (n - 1) + Math.max(changes[i], 0)) / n;
    loss = (loss * (n - 1) + Math.max(-changes[i], 0)) / n;
    out[i + 1] = rsi(gain, loss);
  }
  return out;
}

/**
 * Long calm uptrend, then a steady slide: identical daily losses keep realized
 * volatility near zero (the vol gate never trips) and the slide stays well inside
 * a wide SMA band, so only the RSI brake can see it. Then a steady recovery.
 */
function calmSlide(): { prices: number[]; slideStart: number; slideEnd: number } {
  const prices = [100];
  const push = (r: number) => prices.push(prices[prices.length - 1] * (1 + r));
  for (let i = 0; i < 200; i++) push(0.001);
  const slideStart = prices.length;
  for (let i = 0; i < 15; i++) push(-0.007);
  const slideEnd = prices.length;
  for (let i = 0; i < 30; i++) push(0.004);
  return { prices, slideStart, slideEnd };
}

test("the shipped brake is RSI(14) below 18, released above 62, on both indices", () => {
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.deepEqual(SMA_RSI_BRAKE[index], { periodDays: 14, exitBelow: 18, reenterAbove: 62 });
  }
  assert.equal(rsiBrakeParamsTextFor(["sp500", "nasdaq100"]), "RSI 14d <18 >62");
});

test("smaRiskOffGates bundles each index's vol gate with its RSI brake", () => {
  for (const index of ["sp500", "nasdaq100"] as const) {
    assert.deepEqual(smaRiskOffGates(index), { volGate: SMA_VOL_GATE[index], rsiBrake: SMA_RSI_BRAKE[index] });
  }
});

test("computeWilderRsi matches a textbook Wilder RSI and is NaN until a full period", () => {
  const prices = [100];
  for (let i = 0; i < 60; i++) prices.push(prices[i] * (1 + 0.013 * Math.sin(i * 1.7) + 0.002));
  const rsi = computeWilderRsi(prices, 14);
  const expected = referenceRsi(prices, 14);
  for (let i = 0; i < 14; i++) assert.ok(Number.isNaN(rsi[i]), `index ${i}`);
  for (let i = 14; i < prices.length; i++) assert.ok(Math.abs(rsi[i] - expected[i]) < 1e-9, `index ${i}`);
});

test("computeWilderRsi: all gains is 100, all losses is 0, flat is neutral", () => {
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  const flat = Array.from({ length: 20 }, () => 100);
  assert.equal(computeWilderRsi(up, 14).at(-1), 100);
  assert.equal(computeWilderRsi(down, 14).at(-1), 0);
  assert.equal(computeWilderRsi(flat, 14).at(-1), 50);
});

test("computeWilderRsi treats a missing close as no change rather than poisoning the series", () => {
  const prices = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i));
  prices[20] = NaN;
  const rsi = computeWilderRsi(prices, 14);
  assert.ok(Number.isFinite(rsi.at(-1)!));
});

test("nextRsiBrakeRiskOff trips below the exit level and releases only above the re-entry level", () => {
  assert.equal(nextRsiBrakeRiskOff(false, 18, BRAKE), false);
  assert.equal(nextRsiBrakeRiskOff(false, 17.9, BRAKE), true);
  assert.equal(nextRsiBrakeRiskOff(true, 40, BRAKE), true);
  assert.equal(nextRsiBrakeRiskOff(true, 62, BRAKE), true);
  assert.equal(nextRsiBrakeRiskOff(true, 62.1, BRAKE), false);
  assert.equal(nextRsiBrakeRiskOff(true, NaN, BRAKE), true);
  assert.equal(nextRsiBrakeRiskOff(false, NaN, BRAKE), false);
});

test("the brake trips during a calm slide and releases on the recovery", () => {
  const { prices, slideStart, slideEnd } = calmSlide();
  const brake = computeRsiBrakeRiskOff(prices, BRAKE);
  assert.equal(brake[slideStart - 1], false);
  assert.equal(brake[slideEnd - 1], true);
  assert.equal(brake[brake.length - 1], false);
});

test("generateSmaSignals with the brake steps aside through the slide and labels it an RSI trigger", () => {
  const { prices, slideStart, slideEnd } = calmSlide();
  const dates = isoDates(prices.length);
  const band = { upper: 0, lower: 20 };
  const plain = generateSmaSignals(dates, prices, 100, band, { volGate: SMA_VOL_GATE.sp500 });
  assert.equal(plain.signals.length, 0, "neither the band nor the vol gate sees the slide");

  const braked = generateSmaSignals(dates, prices, 100, band, smaRiskOffGates("sp500"));
  assert.deepEqual(braked.signals.map((s) => [s.type, s.trigger]), [["sell", "rsi"], ["buy", "rsi"]]);
  const sellIdx = dates.indexOf(braked.signals[0]!.date);
  const buyIdx = dates.indexOf(braked.signals[1]!.date);
  assert.ok(sellIdx >= slideStart && sellIdx < slideEnd);
  assert.ok(buyIdx >= slideEnd);
  assert.equal(braked.invested[slideEnd - 1], false);
  assert.equal(braked.invested.at(-1), true);
});

test("the brake alone also labels its trades, and caching keeps braked and unbraked runs apart", () => {
  const { prices } = calmSlide();
  const dates = isoDates(prices.length);
  const band = { upper: 0, lower: 20 };
  const brakeOnly = generateSmaSignals(dates, prices, 100, band, { rsiBrake: BRAKE });
  assert.deepEqual(brakeOnly.signals.map((s) => s.trigger), ["rsi", "rsi"]);
  const none = generateSmaSignals(dates, prices, 100, band);
  assert.equal(none.signals.length, 0);
});

test("the brake never buys while the SMA band says risk-off", () => {
  const prices = [100];
  const push = (r: number) => prices.push(prices[prices.length - 1] * (1 + r));
  for (let i = 0; i < 120; i++) push(0.002);
  for (let i = 0; i < 40; i++) push(-0.01);
  for (let i = 0; i < 20; i++) push(0.006);
  const dates = isoDates(prices.length);
  const { invested, signals } = generateSmaSignals(dates, prices, 50, { upper: 5, lower: 2 }, smaRiskOffGates("sp500"));
  assert.ok(computeWilderRsi(prices, 14).at(-1)! > BRAKE.reenterAbove, "the brake itself has released");
  assert.equal(invested.at(-1), false);
  assert.equal(signals.filter((s) => s.type === "buy").length, 0);
});

test("getSmaSignal reports a tripped brake as a sell only when the brake is requested", () => {
  const { prices, slideEnd } = calmSlide();
  const dates = isoDates(prices.length);
  const daily: DailyPrice[] = prices.slice(0, slideEnd).map((close, i) => ({ date: dates[i]!, name: "SPX", close, source: "test" }));

  const volOnly = getSmaSignal(daily, 100, { upper: 0, lower: 20 }, { volGate: SMA_VOL_GATE.sp500 });
  assert.notEqual(volOnly.signal, "sell");
  assert.equal(volOnly.rsi, undefined);
  assert.equal(volOnly.rsiBrakeRiskOff, undefined);

  const braked = getSmaSignal(daily, 100, { upper: 0, lower: 20 }, smaRiskOffGates("sp500"));
  assert.equal(braked.signal, "sell");
  assert.equal(braked.signalLabel, "Sell L-ETFs: RSI Brake");
  assert.equal(braked.rsiBrakeRiskOff, true);
  assert.equal(braked.volGateRiskOff, false);
  assert.ok((braked.rsi ?? 100) < BRAKE.exitBelow);
});

test("the Signals snapshot applies the brake whenever the gate switch is on", () => {
  const { prices, slideEnd } = calmSlide();
  const dates = isoDates(prices.length);
  const daily: DailyPrice[] = prices.slice(0, slideEnd).map((close, i) => ({ date: dates[i]!, name: "X", close, source: "test" }));
  const config = { ...getDefaultSmaSignalConfig(), smaSpPeriod: 100, smaSpUpperBuffer: 0, smaSpLowerBuffer: 20,
    smaNqPeriod: 100, smaNqUpperBuffer: 0, smaNqLowerBuffer: 20 };
  const on = computeSmaSignalSnapshot({ sp500Prices: daily, nasdaqPrices: daily, config: { ...config, smaVolGate: true } });
  assert.equal(on.sp500.rsiBrakeRiskOff, true);
  assert.equal(on.nasdaq100.signal, "sell");
  const off = computeSmaSignalSnapshot({ sp500Prices: daily, nasdaqPrices: daily, config: { ...config, smaVolGate: false } });
  assert.equal(off.sp500.rsiBrakeRiskOff, undefined);
  assert.notEqual(off.sp500.signal, "sell");
});

test("signal history reports brake flips with an rsi trigger", () => {
  const { prices } = calmSlide();
  const dates = isoDates(prices.length);
  const history = summarizeSignalHistory({
    index: "nasdaq100",
    prices: prices.map((close, i) => ({ date: dates[i]!, close, adj_close: close })),
    smaPeriod: 100, smaUpperBuffer: 0, smaLowerBuffer: 20, smaVolGate: true,
    startDate: dates[0]!, endDate: dates.at(-1)!, maxSeriesRows: 10,
  });
  assert.deepEqual(history.crossovers.map((c) => [c.type, c.trigger]), [["sell", "rsi"], ["buy", "rsi"]]);
});

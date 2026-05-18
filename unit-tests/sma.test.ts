import test from "node:test";
import assert from "node:assert/strict";
import { computeSma, generateSmaSignals } from "@/lib/simulation/sma";
import { getSmaSignal } from "@/lib/sma-signals";
import type { DailyPrice } from "@/lib/data/storage/types";

// --- computeSma ---

test("computeSma returns NaN for warm-up positions and correct averages after", () => {
  const result = computeSma([1, 2, 3, 4, 5], 3);
  assert.equal(result.length, 5);
  assert.ok(isNaN(result[0]));
  assert.ok(isNaN(result[1]));
  assert.equal(result[2], 2);
  assert.equal(result[3], 3);
  assert.equal(result[4], 4);
});

test("computeSma period 1 equals the input series", () => {
  const prices = [10, 20, 30];
  assert.deepEqual(computeSma(prices, 1), [10, 20, 30]);
});

test("computeSma handles empty input", () => {
  assert.deepEqual(computeSma([], 3), []);
});

test("computeSma caches results for the same prices reference", () => {
  const prices = [1, 2, 3, 4, 5];
  const first = computeSma(prices, 3);
  const second = computeSma(prices, 3);
  assert.strictEqual(first, second);
});

// --- generateSmaSignals ---

function makeDates(count: number, startYear = 2020): string[] {
  const dates: string[] = [];
  let d = new Date(`${startYear}-01-01T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

test("generateSmaSignals emits sell when price drops below SMA minus buffer", () => {
  // Prices: 3 days at 100 (establishes SMA=100), then drop to 80 (< 95 lower band)
  const prices = [100, 100, 100, 100, 80];
  const dates = makeDates(prices.length);
  const { signals, invested } = generateSmaSignals(dates, prices, 3, 5);

  const sells = signals.filter((s) => s.type === "sell");
  assert.equal(sells.length, 1);
  assert.equal(sells[0].price, 80);
  assert.equal(invested[4], false);
});

test("generateSmaSignals emits buy when price recovers above SMA plus buffer", () => {
  // Drop below band to trigger sell, then spike above to trigger buy
  const prices = [100, 100, 100, 100, 80, 200];
  const dates = makeDates(prices.length);
  const { signals } = generateSmaSignals(dates, prices, 3, 5);

  const types = signals.map((s) => s.type);
  assert.ok(types.includes("sell"), "should have a sell signal");
  assert.ok(types.includes("buy"), "should have a buy signal after recovery");
  assert.ok(types.indexOf("sell") < types.indexOf("buy"), "sell before buy");
});

test("generateSmaSignals starts fully invested and holds within buffer", () => {
  // Prices drift gently — never break buffer bands
  const prices = [100, 101, 100, 101, 100];
  const dates = makeDates(prices.length);
  const { signals, invested } = generateSmaSignals(dates, prices, 3, 10);

  assert.equal(signals.length, 0);
  assert.ok(invested.every((v) => v === true));
});

test("generateSmaSignals handles progressive warm-up before SMA is available", () => {
  const dates = ["d1", "d2", "d3"];
  const prices = [100, 50, 100];
  // SMA(4) will be NaN for all.
  // Progressive averages:
  // d1: NaN. isInvested = true.
  // d2: 150/2 = 75. Price=50. buffer=0. lower band=75. 50 < 75. SELL.
  // d3: 250/3 = 83.33. Price=100. buffer=0. upper band=83.33. 100 > 83.33. BUY.
  const result = generateSmaSignals(dates, prices, 4, 0);

  assert.equal(result.invested[0], true);
  assert.equal(result.invested[1], false);
  assert.equal(result.invested[2], true);
  
  assert.equal(result.signals.length, 2);
  assert.equal(result.signals[0].type, "sell");
  assert.equal(result.signals[0].date, "d2");
  assert.equal(result.signals[1].type, "buy");
  assert.equal(result.signals[1].date, "d3");
});

// --- getSmaSignal ---

function makeDailyPrices(closes: number[]): DailyPrice[] {
  return closes.map((close, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, "0")}`,
    close,
    name: "spy",
    source: "test",
  }));
}

test("getSmaSignal returns hold with no-data for empty prices", () => {
  const result = getSmaSignal([], 200, 3);
  assert.equal(result.signal, "hold");
  assert.equal(result.signalLabel, "No Data");
});

test("getSmaSignal returns hold for period <= 0", () => {
  const prices = makeDailyPrices([100, 101, 102]);
  const result = getSmaSignal(prices, 0, 3);
  assert.equal(result.signal, "hold");
});

test("getSmaSignal throws when a price has no finite close", () => {
  const prices: DailyPrice[] = [
    { date: "2024-01-01", close: 100, name: "spy", source: "test" },
    { date: "2024-01-02", close: undefined as unknown as number, name: "spy", source: "test" },
  ];
  assert.throws(() => getSmaSignal(prices, 1, 0));
});

test("getSmaSignal returns buy when price is above SMA plus buffer", () => {
  // SMA(3) of [100, 100, 100] = 100; buffer 5% → upper band = 105; price = 110 → buy
  const prices = makeDailyPrices([100, 100, 100, 110]);
  const result = getSmaSignal(prices, 3, 5);
  assert.equal(result.signal, "buy");
  assert.equal(result.signalLabel, "Buy");
  assert.equal(result.signalEmoji, "🟢");
});

test("getSmaSignal returns sell when price is below SMA minus buffer", () => {
  // SMA(3) of [100, 100, 80] ≈ 93.33; buffer 5% → lower band ≈ 88.67; price = 80 → sell
  const prices = makeDailyPrices([100, 100, 100, 100, 80]);
  const result = getSmaSignal(prices, 3, 5);
  assert.equal(result.signal, "sell");
  assert.equal(result.signalLabel, "Sell");
  assert.equal(result.signalEmoji, "🔴");
});

test("getSmaSignal hold exposes correct numeric values", () => {
  // Price exactly at SMA → within buffer zone
  const prices = makeDailyPrices([100, 100, 100, 100]);
  const result = getSmaSignal(prices, 3, 5);
  assert.equal(result.indexValue, 100);
  assert.ok(Number.isFinite(result.smaValue));
  assert.ok(Number.isFinite(result.percentDiff));
});

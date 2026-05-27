import test from "node:test";
import assert from "node:assert/strict";
import { getSmaSignal } from "../src/lib/sma-signals";
import type { DailyPrice } from "../src/lib/data/storage/types";

test("getSmaSignal returns empty response for no data or zero period", () => {
  const noDataRes = getSmaSignal([], 10, { upper: 0, lower: 0 });
  assert.equal(noDataRes.signal, "hold");
  assert.equal(noDataRes.signalLabel, "No Data");

  const zeroPeriodRes = getSmaSignal([{ date: "2020", name: "SPY", close: 100, source: "test" }], 0, { upper: 0, lower: 0 });
  assert.equal(zeroPeriodRes.signalLabel, "No Data");
});

test("getSmaSignal rejects missing close price", () => {
  const prices: DailyPrice[] = [{ date: "2020", name: "SPY", close: undefined as unknown as number, source: "test" }];
  assert.throws(() => getSmaSignal(prices, 2, { upper: 0, lower: 0 }), /Missing close price for SPY on 2020/);
});

test("getSmaSignal returns insufficient data if SMA is not yet available", () => {
  const prices: DailyPrice[] = [
    { date: "2020", name: "SPY", close: 100, source: "test" },
    { date: "2021", name: "SPY", close: 110, source: "test" }
  ];
  // Period = 3, so SMA is NaN
  const res = getSmaSignal(prices, 3, { upper: 0, lower: 0 });
  assert.equal(res.signal, "hold");
  assert.equal(res.signalLabel, "Insufficient Data");
  assert.equal(res.smaValue, 0);
  assert.equal(res.percentDiff, 0);
});

test("getSmaSignal calculates correct buy signal", () => {
  const prices: DailyPrice[] = [
    { date: "2020", name: "SPY", close: 100, source: "test" },
    { date: "2021", name: "SPY", close: 100, source: "test" },
    { date: "2022", name: "SPY", close: 110, source: "test" }
  ];
  const res = getSmaSignal(prices, 2, { upper: 0, lower: 0 });
  assert.equal(res.signal, "buy");
  assert.equal(res.signalLabel, "Buy");
  assert.equal(res.smaValue, 105);
  assert.equal(Math.abs(res.percentDiff - 4.7619) < 0.001, true);
});

test("getSmaSignal calculates correct sell signal", () => {
  const prices: DailyPrice[] = [
    { date: "2020", name: "SPY", close: 100, source: "test" },
    { date: "2021", name: "SPY", close: 100, source: "test" },
    { date: "2022", name: "SPY", close: 90, source: "test" }
  ];
  const res = getSmaSignal(prices, 2, { upper: 0, lower: 0 });
  assert.equal(res.signal, "sell");
  assert.equal(res.signalLabel, "Sell");
  assert.equal(res.smaValue, 95);
});

test("getSmaSignal outputs Buy L-ETFs within buffer if last cross was up", () => {
  const prices: DailyPrice[] = [
    { date: "p1", name: "SPY", close: 100, source: "test" },
    { date: "p2", name: "SPY", close: 100, source: "test" },
    { date: "p3", name: "SPY", close: 200, source: "test" },
    { date: "p4", name: "SPY", close: 200, source: "test" }
  ];
  const res = getSmaSignal(prices, 2, { upper: 10, lower: 10 });
  assert.equal(res.signal, "hold");
  assert.equal(res.signalLabel, "Buy L-ETFs");
  assert.equal(res.signalEmoji, "🟢");
});

test("getSmaSignal outputs Sell L-ETFs within buffer if last cross was down", () => {
  const prices: DailyPrice[] = [
    { date: "p1", name: "SPY", close: 200, source: "test" },
    { date: "p2", name: "SPY", close: 200, source: "test" },
    { date: "p3", name: "SPY", close: 100, source: "test" },
    { date: "p4", name: "SPY", close: 100, source: "test" }
  ];
  const res = getSmaSignal(prices, 2, { upper: 10, lower: 10 });
  assert.equal(res.signal, "hold");
  assert.equal(res.signalLabel, "Sell L-ETFs");
  assert.equal(res.signalEmoji, "🔴");
});

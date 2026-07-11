import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest, simulateWithWarmUp } from "../src/lib/simulation/engine";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

// SMA period 2, no buffers, trigger-day-close:
//   2020-01-06 close 90 < SMA(102,90)=96      → sell signal
//   2020-01-09 close 95 > SMA(88,95)=91.5     → buy signal
const prices: PricePoint[] = [
  { date: "2020-01-01", adj_close: 10.0, close: 100 },
  { date: "2020-01-02", adj_close: 10.1, close: 101 },
  { date: "2020-01-03", adj_close: 10.2, close: 102 },
  { date: "2020-01-06", adj_close: 9.0, close: 90 },
  { date: "2020-01-07", adj_close: 8.9, close: 89 },
  { date: "2020-01-08", adj_close: 8.8, close: 88 },
  { date: "2020-01-09", adj_close: 9.5, close: 95 },
  { date: "2020-01-10", adj_close: 9.6, close: 96 },
];

const rates: RatePoint[] = [
  { date: "2020-01-01", rateValue: 0.05, rateType: "borrow" },
];

const smaConfig: EtfConfig = {
  id: "upro",
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  smaEnabled: true,
  smaPeriod: 2,
  smaUpperBuffer: 0,
  smaLowerBuffer: 0,
  smaIndex: "sp500",
  smaExecutionMode: "trigger-day-close",
  riskOffAsset: "SGOV",
};

test("simulateBacktest marks the SMA variant as starting invested", () => {
  const result = simulateBacktest(prices, rates, [smaConfig]);
  const sma = result.etfResults.find((r) => r.id === "upro-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.smaStartInvested, true);
});

test("simulateBacktest leaves smaStartInvested undefined on the No-SMA variant", () => {
  const result = simulateBacktest(prices, rates, [smaConfig]);
  const base = result.etfResults.find((r) => r.id === "upro-base");
  assert.notEqual(base, undefined);
  assert.equal(base!.smaStartInvested, undefined);
});

test("simulateWithWarmUp reports risk-off start when a warm-up sell precedes the window", () => {
  // Window starts 2020-01-07: the 2020-01-06 sell happened during warm-up,
  // so the strategy enters the display window risk-off.
  const result = simulateWithWarmUp(prices, rates, [smaConfig], "2020-01-07", 100);
  const sma = result.etfResults.find((r) => r.id === "upro-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.dates[0], "2020-01-07");
  assert.equal(sma!.smaStartInvested, false);
  // Pre-window signals are filtered; only the in-window buy remains.
  assert.deepEqual(
    sma!.smaSignals.map((s) => ({ date: s.date, type: s.type })),
    [{ date: "2020-01-09", type: "buy" }]
  );
});

test("simulateWithWarmUp reports risk-on start when no warm-up signal fired", () => {
  const result = simulateWithWarmUp(prices, rates, [smaConfig], "2020-01-02", 100);
  const sma = result.etfResults.find((r) => r.id === "upro-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.dates[0], "2020-01-02");
  assert.equal(sma!.smaStartInvested, true);
});

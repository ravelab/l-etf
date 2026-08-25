import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest, simulateWithWarmUp } from "../src/lib/simulation/engine";
import { runParallelBacktest } from "../src/lib/simulation/parallel";
import { getRiskOffSpread, getSymbolSpread } from "../src/lib/constants";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

// QLD (2 bp regular) vs SGOV (1 bp regular) so entry/exit spreads differ by regime.
const QLD_SPREAD = getSymbolSpread("QLD", false);
const SGOV_SPREAD = getRiskOffSpread("SGOV", false);

const rates: RatePoint[] = [
  { date: "2020-01-01", rateValue: 0.05, rateType: "borrow" },
];

function makeConfig(overrides: Partial<EtfConfig> = {}): EtfConfig {
  return {
    id: "QLD",
    name: "QLD",
    leverage: 2,
    expenseRatio: 0.95,
    simulated: true,
    smaEnabled: true,
    smaPeriod: 2,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    smaIndex: "nasdaq100",
    smaExecutionMode: "trigger-day-close",
    riskOffAsset: "SGOV",
    ...overrides,
  };
}

function pricePoints(closes: number[], dates: string[]): PricePoint[] {
  return closes.map((close, i) => ({
    date: dates[i],
    adj_close: close / 10,
    close,
  }));
}

test("trigger-day-close: sell signal on the final day exits at the risk-off spread", () => {
  // SMA(2): rising closes stay invested; final close 90 < SMA(103,90)=96.5 → sell
  // on the last day, executed at that same close. The transition is charged in
  // the loop, so the liquidated position is the risk-off asset.
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
  const prices = pricePoints([100, 101, 102, 103, 90], dates);

  const result = simulateBacktest(prices, rates, [makeConfig()]);
  const sma = result.etfResults.find((r) => r.id === "QLD-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.smaSignals[sma!.smaSignals.length - 1]?.type, "sell");

  const rawFinal = sma!.dailyValues[sma!.dailyValues.length - 1];
  const expectedFinal = rawFinal * (1 - SGOV_SPREAD);
  assert.ok(
    Math.abs(sma!.finalValue - expectedFinal) < 1e-12,
    `finalValue should deduct the SGOV exit spread, got ${sma!.finalValue}, expected ${expectedFinal}`
  );
});

test("trigger-day-close: buy signal on the final day exits at the risk-on spread", () => {
  // Sell on 2020-01-03 (90 < SMA(101,90)=95.5), then a rebound on the last day
  // (95 > SMA(88,95)=91.5) → buy executed at the final close.
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"];
  const prices = pricePoints([100, 101, 90, 89, 88, 95], dates);

  const result = simulateBacktest(prices, rates, [makeConfig()]);
  const sma = result.etfResults.find((r) => r.id === "QLD-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.smaSignals[sma!.smaSignals.length - 1]?.type, "buy");

  const rawFinal = sma!.dailyValues[sma!.dailyValues.length - 1];
  const expectedFinal = rawFinal * (1 - QLD_SPREAD);
  assert.ok(
    Math.abs(sma!.finalValue - expectedFinal) < 1e-12,
    `finalValue should deduct the QLD exit spread, got ${sma!.finalValue}, expected ${expectedFinal}`
  );
});

test("next-day-close: sell signal on the second-to-last day still exits at the risk-on spread", () => {
  // The sell fires one day before the window ends, so its execution coincides
  // with the final liquidation: no transition is charged and the LETF is what
  // gets liquidated.
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"];
  const prices = pricePoints([100, 101, 102, 103, 90, 89], dates);

  const config = makeConfig({ smaExecutionMode: "next-day-close" });
  const result = simulateBacktest(prices, rates, [config]);
  const sma = result.etfResults.find((r) => r.id === "QLD-sma");
  assert.notEqual(sma, undefined);

  const rawFinal = sma!.dailyValues[sma!.dailyValues.length - 1];
  const expectedFinal = rawFinal * (1 - QLD_SPREAD);
  assert.ok(
    Math.abs(sma!.finalValue - expectedFinal) < 1e-12,
    `finalValue should deduct the QLD exit spread, got ${sma!.finalValue}, expected ${expectedFinal}`
  );
});

test("per-config trim uses the carried-in risk-off regime for entry and exit spreads", async () => {
  // Sell fires 2020-01-06 (90 < SMA(102,90)=96), before the display window, and
  // closes keep declining so the strategy stays risk-off with zero in-window
  // signals. The trimmed series must charge SGOV entry/exit spreads, not QLD.
  const dates = [
    "2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06",
    "2020-01-07", "2020-01-08", "2020-01-09", "2020-01-10",
  ];
  const prices = pricePoints([100, 101, 102, 90, 89, 88, 87, 86], dates);

  const config = makeConfig({ displayStartDate: "2020-01-08" });
  const result = await runParallelBacktest({
    prices,
    rates,
    startDate: "2020-01-07",
    endDate: "2020-01-10",
    configs: [config],
  });
  const sma = result.etfResults.find((r) => r.id === "QLD-sma");
  assert.notEqual(sma, undefined);
  assert.equal(sma!.dates[0], "2020-01-08");
  assert.equal(sma!.smaStartInvested, false);
  assert.equal(sma!.smaSignals.length, 0);

  // Entry: the window opens risk-off, so the initial buy pays the SGOV spread.
  assert.ok(
    Math.abs(sma!.dailyValues[0] - (1 - SGOV_SPREAD)) < 1e-12,
    `first value should be 1 - SGOV spread, got ${sma!.dailyValues[0]}`
  );

  // Exit: still risk-off at the window end, so liquidation pays the SGOV spread.
  const rawFinal = sma!.dailyValues[sma!.dailyValues.length - 1];
  const expectedFinal = rawFinal * (1 - SGOV_SPREAD);
  assert.ok(
    Math.abs(sma!.finalValue - expectedFinal) < 1e-12,
    `finalValue should deduct the SGOV exit spread, got ${sma!.finalValue}, expected ${expectedFinal}`
  );
});

test("warm-up slice path deducts the exit spread and scopes trade cost to the window", () => {
  // Same series as the trigger-day-close case, extended with leading warm-up
  // days so simulateWithWarmUp takes sliceBacktestResultToWindow (displayIdx>0).
  const dates = [
    "2019-12-26", "2019-12-27", "2019-12-30", "2019-12-31",
    "2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07",
  ];
  //  warm-up: 100→80 forces a sell during warm-up (a trade outside the window)
  const prices = pricePoints([100, 100, 100, 80, 100, 101, 102, 103, 90], dates);

  const warmUpRates: RatePoint[] = [
    { date: "2019-12-01", rateValue: 0.05, rateType: "borrow" },
  ];
  const result = simulateWithWarmUp(prices, warmUpRates, [makeConfig()], "2020-01-01", 4);
  const sma = result.etfResults.find((r) => r.id === "QLD-sma");
  assert.notEqual(sma, undefined);
  // The reported window must start at the display date, not the warm-up start.
  assert.equal(sma!.dates[0], "2020-01-01");

  const rawFinal = sma!.dailyValues[sma!.dailyValues.length - 1];
  const endsInRiskOff = sma!.smaSignals[sma!.smaSignals.length - 1]?.type === "sell";
  const exitSpread = endsInRiskOff ? SGOV_SPREAD : QLD_SPREAD;
  const expectedFinal = rawFinal * (1 - exitSpread);
  assert.ok(
    Math.abs(sma!.finalValue - expectedFinal) < 1e-12,
    `sliced finalValue should deduct the exit spread, got ${sma!.finalValue}, expected ${expectedFinal}`
  );

  // Trade cost must reflect only in-window trades, so it cannot exceed the cost
  // of an entry + every in-window signal + the exit.
  const inWindowSignals = sma!.smaSignals.filter((s) => s.date >= "2020-01-01").length;
  const maxPlausiblePct =
    ((QLD_SPREAD + exitSpread) * 100) + inWindowSignals * 1.0;
  assert.ok(
    sma!.totalTradingCostPct <= maxPlausiblePct,
    `totalTradingCostPct ${sma!.totalTradingCostPct} should exclude warm-up trades (<= ${maxPlausiblePct})`
  );
});

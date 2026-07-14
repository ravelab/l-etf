import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest, computeSimulatedRiskOnReturn } from "../src/lib/simulation/engine";
import {
  getSymbolSpread,
  getRiskOffSpread,
  getTransitionSpreadCostForConfig,
} from "../src/lib/constants";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

// These tests target the three simulateSingleEtf code paths flagged as
// under-covered: the next-day-open overnight/intraday split (costFraction
// 0.5), priced risk-off share accounting (incl. the mid-hold cash-fallback
// when price data disappears), and risk-off mixture rebalancing across
// composite (multi-ticker) risk-off assets. Every expected value below is
// assembled from the same small formula building blocks the engine itself
// exports (computeSimulatedRiskOnReturn, getSymbolSpread, etc.), chained by
// hand for the specific fixture's known control-flow path — not by
// re-running the engine.

function assertClose(actual: number, expected: number, tolerance: number, msg: string) {
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${msg}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

test("next-day-open: overnight entry and intraday exit legs apply the half-day cost fraction, with cash-fallback compounding between them", () => {
  // SMA(2) on close: sell signal fires day 3 (80 < SMA(100,80)=90), buy
  // signal fires day 6 (100 > SMA(80,100)=90). Under next-day-open execution
  // those signals take effect at the *next* day's open, giving one overnight
  // transition (day 4, entering risk-off) and one intraday transition
  // (day 7, exiting risk-off).
  const dates = [
    "2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04",
    "2020-01-05", "2020-01-06", "2020-01-07", "2020-01-08",
  ];
  const closeVals = [100, 100, 100, 80, 80, 80, 100, 100];
  // adj_open custom-gapped only on the two transition days: day4 opens -5%
  // below day3's close; day7 opens below its own close for the intraday leg.
  const openVals = [100, 100, 100, 80, 76, 80, 100, 95];
  const prices: PricePoint[] = dates.map((date, i) => ({
    date,
    adj_close: closeVals[i],
    close: closeVals[i],
    adj_open: openVals[i],
  }));
  const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];

  const config: EtfConfig = {
    id: "upro-nda-open",
    name: "UPRO",
    leverage: 3,
    expenseRatio: 0.91,
    simulated: true,
    smaEnabled: true,
    smaPeriod: 2,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    smaIndex: "sp500",
    smaExecutionMode: "next-day-open",
    riskOffAsset: "SGOV",
  };

  const erDaily = config.expenseRatio / 100 / 252;
  const borrowRate = 0.05 / 360;

  const entrySpread = getSymbolSpread(config.name, false);
  const v0 = 1 * (1 - entrySpread);

  const r1 = computeSimulatedRiskOnReturn(0, borrowRate, "sp500", 3, erDaily);
  const v1 = v0 * (1 + r1);

  const r2 = computeSimulatedRiskOnReturn(0, borrowRate, "sp500", 3, erDaily);
  const v2 = v1 * (1 + r2);

  const r3 = computeSimulatedRiskOnReturn(-0.2, borrowRate, "sp500", 3, erDaily);
  const v3 = v2 * (1 + r3);

  // Day 4: overnight leg, costFraction 0.5. Open 76 vs prior close 80.
  const overnightReturn = 76 / 80 - 1;
  const r4 = computeSimulatedRiskOnReturn(overnightReturn, borrowRate, "sp500", 3, erDaily, 0.5);
  const investableValue4 = v3 * (1 + r4);
  const perTransitionSpread = getTransitionSpreadCostForConfig(config, false);
  const v4 = investableValue4 * (1 - perTransitionSpread);
  // Internal risk-off cash tracking is decoupled from the reported (spread-
  // adjusted) dailyValues — it keeps compounding from the pre-spread value.
  let riskOffCash = investableValue4;

  riskOffCash *= 1 + borrowRate;
  const v5 = riskOffCash;

  riskOffCash *= 1 + borrowRate;
  const v6 = riskOffCash;

  // Day 7: intraday leg, costFraction 0.5. Open 95, close 100 (same day).
  const intradayReturn = 100 / 95 - 1;
  const r7 = computeSimulatedRiskOnReturn(intradayReturn, borrowRate, "sp500", 3, erDaily, 0.5);
  const baseValue7 = riskOffCash * (1 + r7);
  const v7 = baseValue7 * (1 - perTransitionSpread);

  const exitSpread = getSymbolSpread(config.name, false);
  const expectedFinal = v7 - v7 * exitSpread;

  const result = simulateBacktest(prices, rates, [config]);
  const etf = result.etfResults.find((r) => r.id === "upro-nda-open-sma");
  assert.notEqual(etf, undefined);

  const expected = [v0, v1, v2, v3, v4, v5, v6, v7];
  for (let i = 0; i < expected.length; i++) {
    assertClose(etf!.dailyValues[i], expected[i], 1e-9, `dailyValues[${i}]`);
  }
  assertClose(etf!.finalValue, expectedFinal, 1e-9, "finalValue");

  // Sanity: costFraction actually mattered. A same-formula overnight leg
  // computed with costFraction 1 instead of 0.5 must differ meaningfully,
  // otherwise this fixture wouldn't distinguish the two.
  const r4WithFullCost = computeSimulatedRiskOnReturn(overnightReturn, borrowRate, "sp500", 3, erDaily, 1);
  assert.notEqual(r4, r4WithFullCost);
});

test("risk-off entry converts to priced shares and marks-to-market on subsequent holds", () => {
  // SMA(2): sell fires day 2 (90 < SMA(100,90)=95); no re-entry in window.
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05", "2020-01-06"];
  const closeVals = [100, 100, 90, 90, 90, 105];
  const prices: PricePoint[] = dates.map((date, i) => ({
    date,
    adj_close: closeVals[i],
    close: closeVals[i],
  }));
  const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];
  // SGOV close prices: entry at index2 (100), then +1%/+1%, then a final
  // close (99) used only for the re-entry/exit re-mark on day 5.
  const sgov = [100, 100, 100, 101, 102.01, 99];

  const config: EtfConfig = {
    id: "upro-priced-riskoff",
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

  const erDaily = config.expenseRatio / 100 / 252;
  const borrowRate = 0.05 / 360;
  const afterHours = true; // trigger-day-close
  const perTransitionSpread = getTransitionSpreadCostForConfig(config, afterHours);

  const entrySpread = getSymbolSpread(config.name, false);
  const v0 = 1 * (1 - entrySpread);

  const r1 = computeSimulatedRiskOnReturn(0, borrowRate, "sp500", 3, erDaily);
  const v1 = v0 * (1 + r1);

  const r2 = computeSimulatedRiskOnReturn(-0.1, borrowRate, "sp500", 3, erDaily);
  const baseValue2 = v1 * (1 + r2);
  const v2 = baseValue2 * (1 - perTransitionSpread);

  // Day 3: entry into risk-off — buy SGOV at index2's close (100), mark at
  // index3's close (101).
  const shares = v2 / sgov[2];
  const v3 = shares * sgov[3];

  // Day 4: hold — mark at index4's close (102.01), same share count.
  const v4 = shares * sgov[4];

  // Day 5: hasTransition fires (buy signal) even though the position is
  // still nominally risk-off for the return calc — the engine re-buys at
  // index4's close using day4's value, then marks + charges the spread at
  // index5's close.
  const sharesReentry = v4 / sgov[4];
  const baseValue5 = sharesReentry * sgov[5];
  const v5 = baseValue5 * (1 - perTransitionSpread);

  const exitSpread = getSymbolSpread(config.name, false);
  const expectedFinal = v5 - v5 * exitSpread;

  const result = simulateBacktest(prices, rates, [config], {
    riskOffValuesByAsset: { SGOV: sgov },
  });
  const etf = result.etfResults.find((r) => r.id === "upro-priced-riskoff-sma");
  assert.notEqual(etf, undefined);

  const expected = [v0, v1, v2, v3, v4, v5];
  for (let i = 0; i < expected.length; i++) {
    assertClose(etf!.dailyValues[i], expected[i], 1e-9, `dailyValues[${i}]`);
  }
  assertClose(etf!.finalValue, expectedFinal, 1e-9, "finalValue");

  // Sanity: the priced path must diverge from the pure cash-fallback path
  // (no riskOffValuesByAsset), otherwise this fixture isn't actually
  // exercising share pricing.
  const cashFallbackResult = simulateBacktest(prices, rates, [config]);
  const cashEtf = cashFallbackResult.etfResults.find((r) => r.id === "upro-priced-riskoff-sma");
  assert.notEqual(cashEtf!.finalValue, etf!.finalValue);
});

test("risk-off shares convert to cash and compound at the borrow rate when price data disappears mid-hold", () => {
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05"];
  const closeVals = [100, 100, 90, 90, 90];
  const prices: PricePoint[] = dates.map((date, i) => ({
    date,
    adj_close: closeVals[i],
    close: closeVals[i],
  }));
  const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];
  // SGOV has a real price through index2, then goes missing for both
  // index3 and index4 — index3 still resolves via riskOffCloseMarkPrice's
  // built-in "yesterday" fallback, but index4 has no valid fallback either
  // (index3 is also NaN), forcing the "price suddenly missing" branch.
  const sgov = [100, 100, 100, NaN, NaN];

  const config: EtfConfig = {
    id: "upro-riskoff-missing-price",
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

  const erDaily = config.expenseRatio / 100 / 252;
  const borrowRate = 0.05 / 360;
  const perTransitionSpread = getTransitionSpreadCostForConfig(config, true);

  const entrySpread = getSymbolSpread(config.name, false);
  const v0 = 1 * (1 - entrySpread);

  const r1 = computeSimulatedRiskOnReturn(0, borrowRate, "sp500", 3, erDaily);
  const v1 = v0 * (1 + r1);

  const r2 = computeSimulatedRiskOnReturn(-0.1, borrowRate, "sp500", 3, erDaily);
  const baseValue2 = v1 * (1 + r2);
  const v2 = baseValue2 * (1 - perTransitionSpread);

  // Day 3: entry — buy at index2 (100), mark at index3 falls back to
  // index2's price (100) since index3 itself is NaN, so value is unchanged.
  const v3 = v2;

  // Day 4: mark at index4 is NaN AND its own fallback (index3) is also NaN
  // → converts remaining shares to cash at the last known price (100), then
  // compounds one day at the borrow rate.
  const v4 = v2 * (1 + borrowRate);

  const result = simulateBacktest(prices, rates, [config], {
    riskOffValuesByAsset: { SGOV: sgov },
  });
  const etf = result.etfResults.find((r) => r.id === "upro-riskoff-missing-price-sma");
  assert.notEqual(etf, undefined);

  const expected = [v0, v1, v2, v3, v4];
  for (let i = 0; i < expected.length; i++) {
    assertClose(etf!.dailyValues[i], expected[i], 1e-9, `dailyValues[${i}]`);
  }

  const exitSpread = getRiskOffSpread(config.riskOffAsset, false);
  const expectedFinal = v4 - v4 * exitSpread;
  assertClose(etf!.finalValue, expectedFinal, 1e-9, "finalValue");
});

test("composite risk-off asset rebalances into equal-weight shares across tickers on entry", () => {
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05"];
  const closeVals = [100, 100, 90, 90, 90];
  const prices: PricePoint[] = dates.map((date, i) => ({
    date,
    adj_close: closeVals[i],
    close: closeVals[i],
  }));
  const rates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];
  // BRK.B rises 10%/10%; GLDM stays flat — divergent paths so an incorrect
  // weighting or a shared price bug would show up in the mark-to-market.
  const brkb = [100, 100, 100, 110, 121];
  const gldm = [50, 50, 50, 50, 50];

  const config: EtfConfig = {
    id: "upro-mixture",
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
    riskOffAsset: "BRK.B+GLDM",
  };

  const erDaily = config.expenseRatio / 100 / 252;
  const borrowRate = 0.05 / 360;
  const perTransitionSpread = getTransitionSpreadCostForConfig(config, true);

  const entrySpread = getSymbolSpread(config.name, false);
  const v0 = 1 * (1 - entrySpread);

  const r1 = computeSimulatedRiskOnReturn(0, borrowRate, "sp500", 3, erDaily);
  const v1 = v0 * (1 + r1);

  const r2 = computeSimulatedRiskOnReturn(-0.1, borrowRate, "sp500", 3, erDaily);
  const baseValue2 = v1 * (1 + r2);
  const v2 = baseValue2 * (1 - perTransitionSpread);

  // Day 3: entry — split v2 equally, buy each ticker at index2's close,
  // mark at index3's close.
  const valuePerComponent = v2 / 2;
  const v3 = valuePerComponent * (brkb[3] / brkb[2]) + valuePerComponent * (gldm[3] / gldm[2]);

  // Day 4: hold — mark at index4's close, same share counts.
  const v4 = valuePerComponent * (brkb[4] / brkb[2]) + valuePerComponent * (gldm[4] / gldm[2]);

  const result = simulateBacktest(prices, rates, [config], {
    riskOffValuesByAsset: { "BRK.B": brkb, GLDM: gldm },
  });
  const etf = result.etfResults.find((r) => r.id === "upro-mixture-sma");
  assert.notEqual(etf, undefined);

  const expected = [v0, v1, v2, v3, v4];
  for (let i = 0; i < expected.length; i++) {
    assertClose(etf!.dailyValues[i], expected[i], 1e-9, `dailyValues[${i}]`);
  }

  const exitSpread = getRiskOffSpread(config.riskOffAsset, false);
  const expectedFinal = v4 - v4 * exitSpread;
  assertClose(etf!.finalValue, expectedFinal, 1e-9, "finalValue");

  // Sanity: the mixture result must differ from a same-weight single-ticker
  // (BRK.B-only) run, otherwise GLDM's flat price path isn't actually
  // influencing the outcome.
  const singleTickerConfig: EtfConfig = { ...config, id: "upro-single", riskOffAsset: "BRK.B" };
  const singleResult = simulateBacktest(prices, rates, [singleTickerConfig], {
    riskOffValuesByAsset: { "BRK.B": brkb },
  });
  const singleEtf = singleResult.etfResults.find((r) => r.id === "upro-single-sma");
  assert.notEqual(singleEtf!.finalValue, etf!.finalValue);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSTANT_INITIAL_INVESTMENT as C } from "../src/lib/constants";
import { composeLetfDualSleeveFund } from "../src/lib/simulation/letf-dual-sleeve";
import {
  buildLetfTaxSchedule,
  capitalGainsRates,
  estimateLetfAfterTaxCagr,
  isLongTermHolding,
  settleCapitalGainsYear,
} from "../src/lib/simulation/letf-tax";
import { calcCagr } from "../src/lib/simulation/metrics";
import type { EtfResult, SmaSignal } from "../src/lib/simulation/types";

// A typical high bracket; the shipped default is 0% everywhere.
const RATES = { ltcg: 15, stcg: 22, state: 8, medicare: 3.8 };

const ZERO = { ltcg: 0, stcg: 0, state: 0, medicare: 0 };
// Defaults: short-term 22 + 8 + 3.8, long-term 15 + 8 + 3.8.
const ST = 0.338;
const LT = 0.268;

const near = (actual: number | undefined, expected: number, tol = 1e-9) => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < tol, `${actual} != ${expected}`);
};

/** A simulated SMA sleeve in the engine's dollars; `values` are multiples of the starting amount. */
function sleeve(days: Array<[date: string, value: number, signal?: SmaSignal["type"]]>, startInvested = true): EtfResult {
  const dates = days.map(([date]) => date);
  const dailyValues = days.map(([, value]) => value * C);
  const finalValue = dailyValues[dailyValues.length - 1];
  return {
    id: "x-sma", name: "UPRO (SMA)", sourceIndex: "sp500", dates, dailyValues, finalValue,
    cagr: calcCagr(C, finalValue, dates[0], dates[dates.length - 1]),
    sharpeRatio: 0, sortinoRatio: 0, maxDrawdownPct: 0, maxDrawdownDollar: 0, longestDrawdownDays: 0,
    bestMonth: 0, worstMonth: 0, smaPrices: [], totalTradingCostPct: 0, smaStartInvested: startInvested,
    smaSignals: days.flatMap(([date, , type]) => (type ? [{ date, type, price: 1 }] : [])),
  };
}

function afterTax(result: EtfResult, rates = RATES) {
  return estimateLetfAfterTaxCagr(buildLetfTaxSchedule(result)!, rates);
}

test("rates combine each federal rate with state and Medicare", () => {
  const rates = capitalGainsRates(RATES);
  near(rates.shortTerm, ST);
  near(rates.longTerm, LT);
  near(capitalGainsRates({ ltcg: 100, stcg: 100, state: 50, medicare: 0 }).shortTerm, 1);
});

test("long-term means sold after the first anniversary of the purchase", () => {
  assert.equal(isLongTermHolding("2020-01-15", "2021-01-15"), false);
  assert.equal(isLongTermHolding("2020-01-15", "2021-01-16"), true);
  assert.equal(isLongTermHolding("2020-02-29", "2021-02-28"), false);
  assert.equal(isLongTermHolding("2020-02-29", "2021-03-01"), true);
});

test("a year nets each class, offsets across classes and carries losses by character", () => {
  const rates = { shortTerm: ST, longTerm: LT };
  const none = { shortTerm: 0, longTerm: 0 };
  near(settleCapitalGainsYear({ shortTerm: 10, longTerm: 20 }, none, rates).tax, 10 * ST + 20 * LT);
  // A short-term loss offsets a long-term gain, which keeps its rate.
  near(settleCapitalGainsYear({ shortTerm: -5, longTerm: 20 }, none, rates).tax, 15 * LT);
  near(settleCapitalGainsYear({ shortTerm: 20, longTerm: -5 }, none, rates).tax, 15 * ST);
  assert.deepEqual(settleCapitalGainsYear({ shortTerm: -30, longTerm: 20 }, none, rates), {
    tax: 0, carryover: { shortTerm: 10, longTerm: 0 },
  });
  assert.deepEqual(settleCapitalGainsYear({ shortTerm: 5, longTerm: -20 }, none, rates), {
    tax: 0, carryover: { shortTerm: 0, longTerm: 15 },
  });
  assert.deepEqual(settleCapitalGainsYear({ shortTerm: -1, longTerm: -2 }, none, rates).carryover, { shortTerm: 1, longTerm: 2 });
  // A carryover nets within its own class first.
  near(settleCapitalGainsYear({ shortTerm: 10, longTerm: 20 }, { shortTerm: 0, longTerm: 5 }, rates).tax, 10 * ST + 15 * LT);
});

test("zero rates reproduce the pretax CAGR, including the closing trade", () => {
  const result = sleeve([["2020-01-02", 0.999], ["2020-06-01", 1.4, "sell"], ["2020-06-02", 1.4], ["2021-03-01", 1.5]]);
  const withExit = { ...result, finalValue: result.finalValue * 0.998, cagr: calcCagr(C, result.finalValue * 0.998, "2020-01-02", "2021-03-01") };
  near(afterTax(withExit, ZERO), withExit.cagr);
});

test("buy and hold defers everything to the closing sale, at the long-term rate", () => {
  const result = sleeve([["2020-01-02", 1], ["2020-12-31", 1.6], ["2021-12-31", 2]]);
  near(afterTax(result), calcCagr(C, (2 - 1 * LT) * C, "2020-01-02", "2021-12-31"));
});

test("a position sold within a year pays the short-term rate", () => {
  const result = sleeve([["2020-01-02", 1], ["2020-11-30", 1.5]]);
  near(afterTax(result), calcCagr(C, (1.5 - 0.5 * ST) * C, "2020-01-02", "2020-11-30"));
});

test("a switch realizes its gain at the short-term rate, and unpaid tax settles at the end", () => {
  const result = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 1.5, "sell"], ["2020-06-02", 1.5], ["2020-12-31", 1.5], ["2021-03-01", 1.5],
  ]);
  // 0.5 short-term gain in 2020; the basket bought at 1.5 sells at cost to pay it.
  near(afterTax(result), calcCagr(C, (1.5 - 0.5 * ST) * C, "2020-01-02", "2021-03-01"));
});

test("a loss carries forward into a later year's gain", () => {
  const result = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 0.8, "sell"], ["2020-06-02", 0.8], ["2020-12-31", 0.8, "buy"],
    ["2021-01-04", 0.8], ["2021-12-31", 1.2], ["2022-03-01", 1.2],
  ]);
  // 2020: -0.2 short-term carried. 2022: the LETF bought 2021-01-04 at 0.8 sells at
  // 1.2 after more than a year: 0.4 long-term, less the 0.2 short-term carryover.
  near(afterTax(result), calcCagr(C, (1.2 - 0.2 * LT) * C, "2020-01-02", "2022-03-01"));
});

test("selling at a loss and buying back within 30 days defers the loss into the new shares", () => {
  // Ends before the first estimate falls due, so every year's tax settles at the close.
  const run = (rebuy: string) => sleeve([
    ["2018-01-02", 1], ["2018-12-31", 1.2], ["2019-06-03", 1.5, "sell"], ["2019-06-04", 1.5],
    ["2019-12-09", 1.5, "buy"], ["2019-12-10", 1.5], ["2019-12-19", 1.2, "sell"], ["2019-12-20", 1.2],
    ["2019-12-31", 1.2, "buy"], [rebuy, 1.2], ["2020-03-02", 1.8],
  ]);
  // Washed (re-bought 17 days later): 2019 keeps the whole 0.5 long-term gain, and the
  // 0.3 short-term loss joins the new shares' basis, leaving them 0.3 of gain.
  near(afterTax(run("2020-01-06")), calcCagr(C, (1.8 - 0.5 * LT - 0.3 * ST) * C, "2018-01-02", "2020-03-02"));
  // 38 days later the loss offsets 2019's gain, and the new shares gain 0.6.
  near(afterTax(run("2020-01-27")), calcCagr(C, (1.8 - 0.2 * LT - 0.6 * ST) * C, "2018-01-02", "2020-03-02"));
});

test("estimates are paid by selling shares, whose gains are taxed in the year they are sold", () => {
  const result = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 1.5, "sell"], ["2020-06-02", 1.5], ["2020-12-31", 1.5],
    ["2021-04-15", 2], ["2021-06-01", 2],
  ]);
  // Apr 15 2021 pays 2020's tax plus the first 2021 installment from a basket bought
  // at 1.5 and now worth 2. Those shares' gain is 2021 income, so every dollar of
  // gain is taxed exactly once, all of it short-term.
  near(afterTax(result), calcCagr(C, (2 - 1 * ST) * C, "2020-01-02", "2021-06-01"));
  // Paying earlier than the closing sale costs the growth the paid tax would have earned.
  const paidLate = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 1.5, "sell"], ["2020-06-02", 1.5], ["2020-12-31", 1.5],
    ["2021-04-14", 1.5], ["2021-06-01", 3],
  ]);
  const paidOnTime = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 1.5, "sell"], ["2020-06-02", 1.5], ["2020-12-31", 1.5],
    ["2021-04-15", 1.5], ["2021-06-01", 3],
  ]);
  assert.ok(afterTax(paidOnTime)! < afterTax(paidLate)!, "the April payment misses the later doubling");
});

test("estimates beyond a quiet year's tax are refunded in April and reinvested", () => {
  const flat = ["2020-12-31", "2021-04-15", "2021-06-15", "2021-09-15", "2021-12-31", "2022-01-18", "2022-04-18", "2022-05-02"];
  const result = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 1.5, "sell"], ["2020-06-02", 1.5],
    ...flat.map((date) => [date, 1.5] as [string, number]),
  ]);
  // 2021 realizes nothing, so the installments it paid on 2020's tax all come back.
  near(afterTax(result), calcCagr(C, (1.5 - 0.5 * ST) * C, "2020-01-02", "2022-05-02"));
});

test("an account that cannot cover an installment is ruined", () => {
  const result = sleeve([
    ["2020-01-02", 1], ["2020-06-01", 3, "sell"], ["2020-06-02", 3], ["2020-12-31", 3],
    ["2021-04-15", 0.1], ["2021-06-01", 0.1],
  ]);
  // 2020's tax on a gain of 2 is due in April, after the basket fell to 0.1.
  assert.equal(afterTax(result), -100);
});

test("the two-sleeve fund's estimate matches its pretax CAGR at zero rates through a reset", () => {
  const dates = ["2020-01-02", "2020-06-01", "2020-06-02", "2020-12-31", "2021-01-04", "2021-06-01"];
  const make = (values: number[], startInvested: boolean, signals: SmaSignal[]) => ({
    ...sleeve(dates.map((date, i) => [date, values[i]] as [string, number]), startInvested),
    smaSignals: signals,
  });
  // A is risk-off until it re-enters on 2021-01-04; B is risk-off throughout and, at
  // the reset, holds less than half the fund (buys basket) or more (sells some).
  const a = make([1, 1.1, 1.1, 1.2, 1.5, 1.8], false, [{ date: "2020-12-31", type: "buy", price: 1 }]);
  const cases = [[1, 1, 1, 1.02, 1.02, 1.03], [1, 1.3, 1.3, 1.4, 1.4, 1.41]].flatMap((values) =>
    ["SGOV", "VGSH"].map((riskOffB) => [make(values, false, []), riskOffB] as const)
  );
  for (const [b, riskOffB] of cases) {
    const fund = composeLetfDualSleeveFund({
      id: "f", name: "f",
      primary: { result: a, riskOffAsset: "SGOV" },
      secondary: { result: b, riskOffAsset: riskOffB },
    })!;
    assert.ok(fund.taxSchedule?.events.some((e) => e.reset), "the schedule records the reset");
    near(estimateLetfAfterTaxCagr(fund.taxSchedule!, ZERO), fund.cagr);
    const taxed = estimateLetfAfterTaxCagr(fund.taxSchedule!, RATES)!;
    assert.ok(taxed < fund.cagr, `${riskOffB}: taxes must cost something`);
  }
});

test("a schedule it cannot price is reported as unavailable, ruin as -100%", () => {
  const schedule = buildLetfTaxSchedule(sleeve([["2020-01-02", 1], ["2020-06-01", 1.5]]))!;
  assert.equal(estimateLetfAfterTaxCagr({ ...schedule, events: [] }, RATES), undefined);
  assert.equal(
    estimateLetfAfterTaxCagr({ ...schedule, events: [{ ...schedule.events[0], prices: [0] }] }, RATES),
    undefined,
  );
  assert.equal(buildLetfTaxSchedule(sleeve([["2020-01-02", 1]])), undefined);
  const wiped = buildLetfTaxSchedule(sleeve([["2020-01-02", 1], ["2020-06-01", 1]]))!;
  assert.equal(estimateLetfAfterTaxCagr({ ...wiped, exitFractions: [0] }, RATES), -100);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSTANT_INITIAL_INVESTMENT as C } from "../src/lib/constants";
import {
  afterTaxLetfFundWindow,
  afterTaxPathResult,
  afterTaxWindowResult,
  buildTaxCalendar,
  buyAndHoldAfterTaxValue,
  walkPathRangeStats,
  withAfterTaxWindow,
} from "../src/lib/simulation/after-tax-window";
import { afterTaxBuyAndHoldPath, afterTaxResultPath } from "../src/lib/simulation/after-tax-path";
import { buildDrawdownRangeQuery } from "../src/lib/simulation/drawdown-range";
import { buildForwardFundReturnPoints, buildForwardSmaReturnPoints } from "../src/lib/simulation/forward-sma-returns";
import {
  composeLetfDualSleeveFund,
  heldRiskOnByDay,
  letfTaxCloseEvent,
  type LetfFundPathSleeve,
} from "../src/lib/simulation/letf-dual-sleeve";
import { buildLetfTaxSchedule, capitalGainsRates, runLetfTaxLedger } from "../src/lib/simulation/letf-tax";
import { calcCagr, calcPathMetrics } from "../src/lib/simulation/metrics";
import type { RollingSimulationPoint } from "../src/lib/simulation/rolling";
import type { EtfConfig, EtfResult, LetfTaxEvent, PricePoint, SmaSignal } from "../src/lib/simulation/types";

// A typical high bracket; the shipped default is 0% everywhere.
const RATES = { ltcg: 15, stcg: 22, state: 8, medicare: 3.8 };
const ZERO = { ltcg: 0, stcg: 0, state: 0, medicare: 0 };

const near = (actual: number | undefined, expected: number, tol = 1e-9) => {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`
  );
};

/** Weekdays from `start`, `count` of them. */
function weekdays(start: string, count: number): string[] {
  const dates: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); dates.length < count; ms += 86_400_000) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

/** A reproducible leveraged-looking walk and a regime that switches every so often. */
function makePath(count: number, seed: number) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const raw: number[] = [];
  const held: boolean[] = [];
  let value = 50;
  let riskOn = true;
  for (let i = 0; i < count; i++) {
    if (rand() < 0.01) riskOn = !riskOn;
    value *= 1 + (rand() - 0.47) * (riskOn ? 0.05 : 0.01);
    raw.push(value);
    held.push(riskOn);
  }
  return { dates: weekdays("2003-02-03", count), raw, held };
}

/**
 * The reference: the ledger replayed with a mark on every close, so each day's
 * account value is read straight off the ledger rather than derived.
 */
function bruteForce(
  dates: string[],
  raw: number[],
  held: boolean[],
  startDay: number,
  endDay: number,
  scale: number,
  exitFraction: number
) {
  const days = dates.slice(startDay, endDay + 1);
  const values = raw.slice(startDay, endDay + 1).map((value) => value * scale);
  const regime = held.slice(startDay, endDay + 1);
  const last = days.length - 1;
  const events: LetfTaxEvent[] = [];
  const markAt: number[] = [];
  for (let k = 0; k <= last; k++) {
    if (k > 0 && regime[k] !== regime[k - 1]) events.push({ date: days[k], prices: [values[k - 1]], switched: [true] });
    markAt.push(events.length);
    events.push(letfTaxCloseEvent(days, k, 0, last, [values[k]]) ?? { date: days[k], prices: [values[k]] });
  }
  const run = runLetfTaxLedger({
    initialInvestment: C, startDate: days[0], endDate: days[last],
    startValues: [values[0]], startPrices: [values[0]], exitFractions: [exitFraction], events,
  }, RATES)!;
  const path = markAt.map((j, k) => (k === last ? run.finalValue : run.unitsAfter[j][0] * values[k]));
  return {
    finalValue: run.finalValue,
    cagr: run.cagr,
    path,
    maxDrawdownPct: calcPathMetrics(path, days).maxDrawdownPct,
  };
}

test("a window taxed from its events matches the daily ledger exactly", () => {
  for (const seed of [3, 11, 2024]) {
    const { dates, raw, held } = makePath(1800, seed);
    const calendar = buildTaxCalendar(dates, (day) => held[day]);
    const stats = buildDrawdownRangeQuery(raw);
    let windows = 0;
    for (let startDay = 0; startDay < 1500; startDay += 97) {
      for (const length of [40, 260, 700, 1290]) {
        const endDay = startDay + length;
        if (endDay >= dates.length) continue;
        const scale = (C * 0.999) / raw[startDay];
        const exitFraction = 0.998;
        const fast = afterTaxWindowResult({ calendar, startDay, endDay, raw, scale, exitFraction, rates: RATES, stats })!;
        const slow = bruteForce(dates, raw, held, startDay, endDay, scale, exitFraction);
        near(fast.finalValue, slow.finalValue);
        near(fast.cagr, slow.cagr);
        near(fast.maxDrawdownPct, slow.maxDrawdownPct);
        windows++;
      }
    }
    assert.ok(windows > 40);
  }
});

test("a stitched path taxed once matches the same path taxed as a window", () => {
  const { dates, raw, held } = makePath(900, 7);
  const values = raw.map((value) => (value * C) / raw[0]);
  const once = afterTaxPathResult({ dates, values, heldRiskOn: held, exitFraction: 1, rates: RATES })!;
  const slow = bruteForce(dates, raw, held, 0, dates.length - 1, C / raw[0], 1);
  near(once.finalValue, slow.finalValue);
  near(once.cagr, slow.cagr);
  near(once.maxDrawdownPct, slow.maxDrawdownPct);
  assert.deepEqual(walkPathRangeStats([3, 5, 2, 4])(0, 3), { pct: 60, min: 2, max: 5 });
});

test("a buy-and-hold pays tax once, when sold: long-term after a year, ordinary for income, none on a loss", () => {
  const { shortTerm, longTerm } = capitalGainsRates(RATES);
  const base = { initialValue: 100, finalValue: 150, rates: RATES };
  near(buyAndHoldAfterTaxValue({ ...base, startDate: "2020-01-02", endDate: "2021-06-01" }), 150 - 50 * longTerm);
  near(buyAndHoldAfterTaxValue({ ...base, startDate: "2020-01-02", endDate: "2020-11-01" }), 150 - 50 * shortTerm);
  near(
    buyAndHoldAfterTaxValue({ ...base, startDate: "2020-01-02", endDate: "2023-01-02", ordinaryIncome: true }),
    150 - 50 * shortTerm
  );
  near(buyAndHoldAfterTaxValue({ ...base, finalValue: 80, startDate: "2020-01-02", endDate: "2023-01-02" }), 80);
  near(buyAndHoldAfterTaxValue({ ...base, rates: ZERO, startDate: "2020-01-02", endDate: "2023-01-02" }), 150);
  // Gaps carry the last close, and only the final value changes.
  const path = afterTaxBuyAndHoldPath(["2020-01-02", "2020-06-01", "2021-06-01"], [100, NaN, 150], RATES)!;
  assert.deepEqual(path.values.slice(0, 2), [100, 100]);
  near(path.values[2], 150 - 50 * longTerm);
});

test("a taxed window keeps its pretax CAGR and taxes the 1x benchmark; one that cannot be priced is a total loss", () => {
  const point: RollingSimulationPoint = {
    startDate: "2020-01-02", endDate: "2022-01-03", finalValue: 2 * C, nonLeveragedFinalValue: 1.5 * C,
    maxDrawdownPct: 30, nonLeveragedMaxDrawdownPct: 20, cagr: 41, totalReturnPct: 100,
    tradeCount: 2, totalTradingCostPct: 0.1,
  };
  const taxed = withAfterTaxWindow(point, { finalValue: 1.8 * C, cagr: 34, maxDrawdownPct: 33 }, RATES);
  assert.equal(taxed.preTaxCagr, 41);
  assert.equal(taxed.cagr, 34);
  near(taxed.totalReturnPct, 80);
  assert.equal(taxed.maxDrawdownPct, 33);
  near(taxed.nonLeveragedFinalValue, 1.5 * C - 0.5 * C * capitalGainsRates(RATES).longTerm);
  assert.equal(taxed.tradeCount, 2);
  const wiped = withAfterTaxWindow(point, null, RATES);
  assert.deepEqual([wiped.finalValue, wiped.cagr, wiped.maxDrawdownPct], [0, -100, 100]);
});

/** An SMA sleeve in the engine's dollars from a path and its held regime. */
function sleeveResult(name: string, dates: string[], raw: number[], held: boolean[]): EtfResult {
  // A switch held from day k was signalled at the previous close.
  const smaSignals: SmaSignal[] = held.flatMap((riskOn, k) =>
    k > 0 && riskOn !== held[k - 1] ? [{ date: dates[k - 1], type: riskOn ? "buy" : "sell", price: 1 }] : []
  );
  const dailyValues = raw.map((value) => (value * C) / raw[0]);
  const finalValue = dailyValues[dailyValues.length - 1];
  return {
    id: `${name}-sma`, name: `${name} (SMA)`, sourceIndex: "sp500", dates, dailyValues, finalValue,
    cagr: calcCagr(C, finalValue, dates[0], dates[dates.length - 1]),
    sharpeRatio: 0, maxDrawdownPct: 0, maxDrawdownDollar: 0, longestDrawdownDays: 0,
    bestMonth: 0, worstMonth: 0, smaPrices: dates.map(() => 1), totalTradingCostPct: 0,
    smaStartInvested: held[0], smaSignals,
  };
}

test("a table row's after-tax path matches the daily ledger, rescaled or not", () => {
  const { dates, raw, held } = makePath(1200, 13);
  const row = sleeveResult("UPRO", dates, raw, held);
  const slow = bruteForce(dates, raw, held, 0, dates.length - 1, C / raw[0], 1);
  const table = afterTaxResultPath(row, RATES)!;
  table.values.forEach((value, day) => near(value, slow.path[day]));
  near(table.cagr, slow.cagr);
  // The futures page builds the schedule, then rescales the row to the account.
  const scaled = afterTaxResultPath({
    ...row,
    taxSchedule: buildLetfTaxSchedule(row),
    dailyValues: row.dailyValues.map((value) => value * 3),
    finalValue: row.finalValue * 3,
  }, RATES)!;
  scaled.values.forEach((value, day) => near(value, 3 * slow.path[day]));
  near(scaled.cagr, slow.cagr);
});

test("the fund taxed as one account agrees between the rolling walk and the table's path", () => {
  const a = makePath(800, 5);
  const b = makePath(800, 19);
  const spx = sleeveResult("UPRO", a.dates, a.raw, a.held);
  const ndx = sleeveResult("TQQQ", b.dates, b.raw, b.held);
  const fund = composeLetfDualSleeveFund({
    id: "fund", name: "fund",
    primary: { result: spx, riskOffAsset: "SGOV" },
    secondary: { result: ndx, riskOffAsset: "VGSH" },
  })!;
  assert.ok(fund.taxSchedule!.events.some((event) => event.reset), "the paths reset the fund at least once");
  const table = afterTaxResultPath(fund, RATES)!;

  // The rolling walk marks the account from each sleeve's own units and prices.
  const dayIndex = Int32Array.from(fund.dates, (_, i) => i);
  const sleeves = [spx, ndx].map((result, s): LetfFundPathSleeve => ({
    dayIndex,
    dailyValues: result.dailyValues,
    heldRiskOn: heldRiskOnByDay(result),
    startValue: result.dailyValues[0] / 2,
    riskOffAsset: s === 0 ? "SGOV" : "VGSH",
    exitFraction: 1,
    totalTradingCostPct: 0,
  })) as [LetfFundPathSleeve, LetfFundPathSleeve];
  const windowed = afterTaxLetfFundWindow({ sleeves, firstDay: 0, dayCount: fund.dates.length, dates: fund.dates, rates: RATES })!;
  near(windowed.finalValue, table.values[table.values.length - 1]);
  near(windowed.cagr, table.cagr);
  near(windowed.maxDrawdownPct, calcPathMetrics(table.values, fund.dates).maxDrawdownPct);

  // Rescaled (the futures page's amount), the path scales with it and the CAGR does not.
  const scaled = afterTaxResultPath({ ...fund, dailyValues: fund.dailyValues.map((v) => v * 3), finalValue: fund.finalValue * 3 }, RATES)!;
  near(scaled.values[scaled.values.length - 1], 3 * table.values[table.values.length - 1]);
  near(scaled.cagr, table.cagr);
});

test("the forward fund return, untaxed and never switching, is the average of its sleeves' returns", () => {
  const count = 400;
  const dates = weekdays("2010-01-04", count);
  const spxRaw = dates.map((_, i) => 100 * Math.pow(1.0006, i));
  const ndxRaw = dates.map((_, i) => 100 * Math.pow(1.0003, i) * (1 + 0.05 * Math.sin(i / 20)));
  const allOn = dates.map(() => true);
  const config = (name: string): EtfConfig => ({
    id: name, name, leverage: 3, expenseRatio: 0.9, simulated: true, smaEnabled: true, smaPeriod: 200,
    smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV",
  } as EtfConfig);
  const prices = (raw: number[]): PricePoint[] =>
    dates.map((date, i) => ({ date, close: raw[i], adj_close: raw[i] } as PricePoint));
  const monthlyCpi = [{ date: "2009-12-01", value: 100 }, { date: "2012-01-01", value: 100 }];
  const spx = { indexPrices: prices(spxRaw), strategyResult: sleeveResult("UPRO", dates, spxRaw, allOn), config: config("UPRO") };
  const ndx = { indexPrices: prices(ndxRaw), strategyResult: sleeveResult("TQQQ", dates, ndxRaw, allOn), config: config("TQQQ") };
  const window = { monthlyCpi, startDate: dates[0], endDate: dates[count - 1] };

  const fundPoints = buildForwardFundReturnPoints({ spx, ndx, ...window });
  const spxPoints = buildForwardSmaReturnPoints({ ...spx, ...window });
  const ndxPoints = buildForwardSmaReturnPoints({ ...ndx, ...window });
  assert.equal(fundPoints.length, count - 252);
  assert.equal(spxPoints.length, fundPoints.length);
  fundPoints.forEach((point, i) => {
    near(point.realReturnFactor, (spxPoints[i].realReturnFactor + ndxPoints[i].realReturnFactor) / 2);
    near(point.gap, (spxPoints[i].gap + ndxPoints[i].gap) / 2);
  });

  // Taxed, every forward return is lower; a year-long hold is short-term.
  const taxed = buildForwardFundReturnPoints({ spx, ndx, ...window, taxRates: RATES });
  assert.equal(taxed.length, fundPoints.length);
  taxed.forEach((point, i) => assert.ok(point.realReturnFactor < fundPoints[i].realReturnFactor));
});

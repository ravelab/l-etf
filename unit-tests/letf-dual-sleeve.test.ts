import test from "node:test";
import assert from "node:assert/strict";
import { getRiskOffSpread } from "@/lib/constants";
import {
  composeLetfDualSleeveFund,
  heldRiskOnByDay,
  LETF_FUND_RESULT_ID,
  withLetfComboFund,
} from "@/lib/simulation/letf-dual-sleeve";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { shortBacktestAssetLabel } from "@/lib/strategy-page-data";
import type { BacktestResult, EtfResult, PricePoint, SmaSignal } from "@/lib/simulation/types";

const DATES = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];

function sleeve(values: number[], opts: { startInvested: boolean; signals?: SmaSignal[]; name?: string }): EtfResult {
  return {
    id: "x", name: opts.name ?? "x", sourceIndex: "sp500", dates: DATES, dailyValues: values,
    finalValue: values.at(-1)!, cagr: 0, sortinoRatio: 0, maxDrawdownPct: 0, maxDrawdownDollar: 0,
    longestDrawdownDays: 0, bestMonth: 0, worstMonth: 0, smaSignals: opts.signals ?? [], smaPrices: [],
    smaStartInvested: opts.startInvested, totalTradingCostPct: 0,
  };
}
const buyOn = (date: string): SmaSignal => ({ date, type: "buy", price: 1 });

test("a signal at one close is held from the next session", () => {
  const held = heldRiskOnByDay(sleeve([1, 1, 1, 1, 1], { startInvested: false, signals: [buyOn(DATES[2])] }));
  assert.deepEqual(held, [false, false, false, true, true]);
});

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));

test("with no reset the fund is half of each sleeve, to rounding", () => {
  const a = sleeve([1, 1.1, 1.3, 1.2, 1.5], { startInvested: true });
  const b = sleeve([1, 0.9, 0.95, 1.1, 1.2], { startInvested: false });
  const fund = composeLetfDualSleeveFund({
    id: "f", name: "f",
    primary: { result: a, riskOffAsset: "SGOV" },
    secondary: { result: b, riskOffAsset: "VGSH" },
  });
  assert.ok(fund);
  fund.dailyValues.forEach((v, i) => assert.ok(near(v, (a.dailyValues[i] + b.dailyValues[i]) / 2), `day ${i}`));
  assert.ok(near(fund.finalValue, (a.finalValue + b.finalValue) / 2));
  assert.deepEqual(fund.smaPrices, [], "two SMAs drive it, so it has no single SMA panel");
});

test("both risk-off and one re-entering resets the fund to 50/50 before the day is stepped", () => {
  // A goes risk-on on day 3; B stays risk-off throughout.
  const a = sleeve([1, 2, 2, 4, 4], { startInvested: false, signals: [buyOn(DATES[2])] });
  const b = sleeve([1, 1, 1, 1, 1], { startInvested: false });
  const run = (riskOffB: string) => composeLetfDualSleeveFund({
    id: "f", name: "f",
    primary: { result: a, riskOffAsset: "SGOV" },
    secondary: { result: b, riskOffAsset: riskOffB },
  })!;
  // Same basket: free. Halves of 1.5 going into day 3, then A doubles.
  const expected = [1, 1.5, 1.5, 0.75 * 2 + 0.75, 0.75 * 2 + 0.75];
  run("SGOV").dailyValues.forEach((v, i) => assert.ok(near(v, expected[i]), `day ${i}: ${v}`));
  // Different baskets: the staying sleeve buys the 0.25 it is moved, at its spread.
  const cost = 0.25 * getRiskOffSpread("VGSH", false);
  const half = (1.5 - cost) / 2;
  assert.ok(Math.abs(run("VGSH").dailyValues[3] - (half * 2 + half)) < 1e-12);
  assert.ok(run("VGSH").totalTradingCostPct > 0);
});

test("a fund needs both sleeves from the same first day", () => {
  const a = sleeve([1, 1, 1, 1, 1], { startInvested: true });
  const late = { ...sleeve([1, 1, 1, 1], { startInvested: true }), dates: DATES.slice(1) };
  assert.equal(composeLetfDualSleeveFund({
    id: "f", name: "f",
    primary: { result: a, riskOffAsset: "SGOV" },
    secondary: { result: late, riskOffAsset: "SGOV" },
  }), null);
});

const points = (closes: number[]): PricePoint[] =>
  closes.map((close, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), open: close, close, adj_close: close,
  }));
// Up, a crash below the SMA, then a recovery above it.
const SP = points([100, 101, 102, 103, 104, 105, 90, 80, 78, 77, 76, 80, 90, 100, 110, 112, 114, 116]);
const NQ = points([200, 203, 206, 209, 212, 215, 180, 160, 150, 148, 147, 150, 152, 154, 156, 220, 230, 240]);
const SGOV = points(SP.map(() => 100));
const RATES = [{ date: SP[0].date, rateType: "borrow", rateValue: 0.02 }];

async function comboRun(): Promise<BacktestResult> {
  const configs = (["UPRO", "TQQQ"] as const).map((name, k) => createPresetEtfConfig(`etf${k + 1}`, ETF_PRESETS[name], {
    smaEnabled: true, smaPeriod: 3, smaUpperBuffer: 0, smaLowerBuffer: 0, riskOffAsset: "SGOV",
  }));
  return runParallelBacktest({
    prices: SP, rates: RATES, startDate: SP[0].date, endDate: SP.at(-1)!.date, configs,
    pricesByIndex: { sp500: SP, nasdaq100: NQ }, riskOffPricesByAsset: { SGOV },
  });
}

test("the derived regime matches the engine: flat on held risk-off days, moving on risk-on ones", async () => {
  const result = await comboRun();
  for (const id of ["etf1-sma", "etf2-sma"]) {
    const etf = result.etfResults.find((r) => r.id === id)!;
    const held = heldRiskOnByDay(etf);
    assert.ok(held.includes(false) && held.includes(true), `${id}: the path must switch`);
    for (let i = 2; i < held.length; i++) {
      // SGOV is flat, so a day held risk-off on both ends cannot move; a held risk-on day always does.
      // The first day after an entry is skipped: the engine sizes the risk-off shares before
      // deducting the transition spread, so that day's mark hands the spread back.
      if (!held[i] && !held[i - 1] && !held[i - 2]) assert.equal(etf.dailyValues[i], etf.dailyValues[i - 1], `${id} ${etf.dates[i]}`);
      if (held[i] && held[i - 1]) assert.notEqual(etf.dailyValues[i], etf.dailyValues[i - 1], `${id} ${etf.dates[i]}`);
    }
  }
});

test("the backtest page appends the fund only to a UPRO+TQQQ run", async () => {
  const result = await comboRun();
  const run = { letf: "UPRO+TQQQ", spxRiskOffAsset: "SGOV", ndxRiskOffAsset: "SGOV" };
  const shown = withLetfComboFund(result, run)!;
  const fund = shown.etfResults.at(-1)!;
  assert.equal(fund.id, LETF_FUND_RESULT_ID);
  assert.equal(shortBacktestAssetLabel(fund.name), "TQQQ/UPRO SMA");
  assert.equal(shown.etfResults.length, result.etfResults.length + 1);
  assert.equal(withLetfComboFund(shown, run), shown, "applying it twice adds nothing");
  assert.equal(withLetfComboFund(result, { ...run, letf: "UPRO" }), result);
  assert.equal(withLetfComboFund(result, null), result);
});

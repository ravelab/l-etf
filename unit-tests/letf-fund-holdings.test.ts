import test from "node:test";
import assert from "node:assert/strict";
import { LETF_FUND_RESULT_ID, withLetfComboFund } from "@/lib/simulation/letf-dual-sleeve";
import { FUND_CASH_ASSET, letfComboFundHoldings, sleeveShareByDay } from "@/lib/simulation/letf-fund-holdings";
import { runParallelBacktest } from "@/lib/simulation/parallel-backtest";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { logAxisFloor, shareAreaBandEdges } from "@/lib/share-area-bands";
import type { BacktestResult, PricePoint, RiskOffAsset } from "@/lib/simulation/types";

const points = (closes: number[]): PricePoint[] =>
  closes.map((close, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10), open: close, close, adj_close: close,
  }));
// Up, a crash below the SMA, then a recovery above it.
const SP = points([100, 101, 102, 103, 104, 105, 90, 80, 78, 77, 76, 80, 90, 100, 110, 112, 114, 116]);
const NQ = points([200, 203, 206, 209, 212, 215, 180, 160, 150, 148, 147, 150, 152, 154, 156, 220, 230, 240]);
// Two basket legs that move apart, so their shares drift after entry.
const BRK = points(SP.map((_, i) => 50 * (1 + 0.02 * i)));
const GLDM = points(SP.map((_, i) => 20 * (1 - 0.01 * i)));
const VGSH = points(SP.map(() => 60));
const RISK_OFF = { "BRK.B": BRK, GLDM, VGSH } as Record<string, PricePoint[]>;
const RATES = [{ date: SP[0].date, rateType: "borrow", rateValue: 0.02 }];
const RUN = { letf: "UPRO+TQQQ", spxRiskOffAsset: "BRK.B+GLDM", ndxRiskOffAsset: "VGSH" };

async function comboRun(): Promise<BacktestResult> {
  const configs = (["UPRO", "TQQQ"] as const).map((name, k) => createPresetEtfConfig(`etf${k + 1}`, ETF_PRESETS[name], {
    smaEnabled: true, smaPeriod: 3, smaUpperBuffer: 0, smaLowerBuffer: 0,
    riskOffAsset: (k === 0 ? RUN.spxRiskOffAsset : RUN.ndxRiskOffAsset) as RiskOffAsset,
  }));
  return runParallelBacktest({
    prices: SP, rates: RATES, startDate: SP[0].date, endDate: SP.at(-1)!.date, configs,
    pricesByIndex: { sp500: SP, nasdaq100: NQ },
    riskOffPricesByAsset: RISK_OFF as Partial<Record<RiskOffAsset, PricePoint[]>>,
  });
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

test("the holdings add up to the fund's value on every close", async () => {
  const result = await comboRun();
  const holdings = letfComboFundHoldings(result, RUN, RISK_OFF)!;
  const fund = withLetfComboFund(result, RUN)!.etfResults.find((etf) => etf.id === LETF_FUND_RESULT_ID)!;
  assert.deepEqual(holdings.dates, fund.dates);
  fund.dailyValues.forEach((value, k) => {
    const sum = holdings.assets.reduce((total, asset) => total + holdings.values[asset][k], 0);
    assert.ok(near(sum, value), `${fund.dates[k]}: ${sum} vs ${value}`);
  });
  assert.deepEqual(holdings.assets, ["UPRO", "BRK.B", "GLDM", "TQQQ", "VGSH"], "each sleeve's LETF, then its own basket");
});

test("a sleeve holds its LETF risk-on and equal basket legs on its entry day", async () => {
  const result = await comboRun();
  const sleeve = result.etfResults.find((etf) => etf.id === "etf1-sma")!;
  const shares = sleeveShareByDay(sleeve, "UPRO", "BRK.B+GLDM", RISK_OFF);
  const entry = shares.findIndex((day, i) => i > 0 && day["BRK.B"] !== undefined && shares[i - 1].UPRO === 1);
  assert.ok(entry > 0, "the fixture must exit");
  assert.ok(near(shares[entry]["BRK.B"], 0.5) && near(shares[entry].GLDM, 0.5), "bought in equal dollars");
  // Held as units afterwards: BRK.B rises and GLDM falls, so BRK.B's share grows.
  const later = shares.findIndex((day, i) => i > entry && day["BRK.B"] !== undefined && day["BRK.B"] > 0.5);
  assert.ok(later > entry);
  shares.forEach((day) => assert.ok(near(Object.values(day).reduce((a, b) => a + b, 0), 1)));
  assert.deepEqual(shares[0], { UPRO: 1 });
});

test("a leg with no price to buy at is held as cash", async () => {
  const result = await comboRun();
  const sleeve = result.etfResults.find((etf) => etf.id === "etf1-sma")!;
  const shares = sleeveShareByDay(sleeve, "UPRO", "BRK.B+GLDM", { "BRK.B": BRK });
  const out = shares.find((day) => day.UPRO === undefined)!;
  assert.ok(out[FUND_CASH_ASSET] > 0 && out["BRK.B"] > 0);
});

test("no fund run means no holdings", async () => {
  const result = await comboRun();
  assert.equal(letfComboFundHoldings(result, { ...RUN, letf: "UPRO" }, RISK_OFF), null);
  assert.equal(letfComboFundHoldings(null, RUN, RISK_OFF), null);
});

test("band edges split the column under the total linearly on screen", () => {
  const values = [[50, 0], [50, 30]];
  const linear = shareAreaBandEdges(values, { logScale: false, floor: 0 });
  assert.deepEqual(linear, [[50, 0], [100, 30]], "linear from zero is plain stacking");

  const floor = 10;
  const log = shareAreaBandEdges(values, { logScale: true, floor });
  // A 50/50 split puts the edge halfway up the log column: the geometric mean.
  assert.ok(near(log[0][0]!, Math.sqrt(floor * 100)));
  assert.ok(near(log[1][0]!, 100), "the top edge is the total");
  assert.ok(near(log[0][1]!, floor), "an empty band has no height");

  assert.deepEqual(shareAreaBandEdges([[0], [0]], { logScale: true, floor }), [[null], [null]]);
  assert.equal(logAxisFloor([40, 0, 10]), 5);
  assert.equal(logAxisFloor([]), 1);
});

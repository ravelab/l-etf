import assert from "node:assert/strict";
import test from "node:test";
import { getRiskOffSpread, getSymbolSpread } from "@/lib/constants";
import { buildForwardSmaReturnPoints } from "@/lib/simulation/forward-sma-returns";
import type { EtfConfig, EtfResult, PricePoint } from "@/lib/simulation/types";

const config: EtfConfig = {
  id: "UPRO-sma-test",
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

const dates = ["2024-01-02", "2024-01-03", "2024-01-04"];
const prices: PricePoint[] = dates.map((date, index) => ({
  date,
  adj_close: 100 + index,
  close: 100 + index,
}));

const strategyResult: EtfResult = {
  id: config.id,
  name: config.name,
  sourceIndex: "sp500",
  dates,
  dailyValues: [10_000, 20_000, 30_000],
  finalValue: 30_000,
  cagr: 0,
  sharpeRatio: 0,
  maxDrawdownPct: 0,
  maxDrawdownDollar: 0,
  longestDrawdownDays: 0,
  bestMonth: 0,
  worstMonth: 0,
  smaSignals: [{ date: dates[1], type: "sell", price: 101 }],
  smaPrices: [100, 100, 100],
  smaStartInvested: true,
  totalTradingCostPct: 0,
};

test("forward SMA return points use the strategy path and risk-off exit regime", () => {
  const points = buildForwardSmaReturnPoints({
    indexPrices: prices,
    strategyResult,
    config,
    monthlyCpi: [],
    startDate: dates[0],
    endDate: dates[2],
    forwardTradingDays: 2,
  });

  assert.equal(points.length, 1);
  assert.equal(points[0].date, dates[0]);
  assert.equal(points[0].gap, 0);

  const expectedFactor = 3
    * (1 - getSymbolSpread("UPRO", false))
    * (1 - getRiskOffSpread("SGOV", false));
  assert.ok(Math.abs(points[0].realReturnFactor - expectedFactor) < 1e-12);
});

test("forward SMA return points are deflated by CPI, not left nominal", () => {
  const args = {
    indexPrices: prices,
    strategyResult,
    config,
    startDate: dates[0],
    endDate: dates[2],
    forwardTradingDays: 2,
  };
  const nominal = buildForwardSmaReturnPoints({ ...args, monthlyCpi: [] });
  // A CPI reading between the entry and the forward date, so the two resolve to
  // different index levels and the ratio is a real 10%.
  const real = buildForwardSmaReturnPoints({
    ...args,
    monthlyCpi: [
      { date: "2024-01-01", value: 100 },
      { date: "2024-01-03", value: 110 },
    ],
  });

  assert.equal(nominal.length, 1);
  assert.equal(real.length, 1);
  // An empty CPI series makes cpiIndexRatioEndOverStart return 1, which silently
  // turns the whole chart nominal — the same way the growth table shipped broken.
  assert.ok(
    Math.abs(real[0].realReturnFactor - nominal[0].realReturnFactor / 1.1) < 1e-12,
    `expected the nominal factor divided by 1.1, got ${real[0].realReturnFactor}`
  );
  assert.ok(real[0].realReturnFactor < nominal[0].realReturnFactor);
});

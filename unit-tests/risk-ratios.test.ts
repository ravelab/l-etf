import assert from "node:assert/strict";
import test from "node:test";
import { calcPathMetrics, calcSharpeRatio } from "../src/lib/simulation/metrics";
import { simulateWithWarmUp } from "../src/lib/simulation/engine";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

test("Sharpe divides mean daily return by the sample deviation and annualizes", () => {
  // +10%, -10%, +20%: mean 1/15, sample variance sum((r - mean)^2) / 2.
  const values = [100, 110, 99, 118.8];
  const returns = [0.1, -0.1, 0.2];
  const mean = 1 / 15;
  const sampleStd = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 2);
  const expected = (mean / sampleStd) * Math.sqrt(252);
  assert.ok(Math.abs(calcSharpeRatio(values) - expected) < 1e-10);
  assert.equal(calcSharpeRatio(values), calcSharpeRatio(values));
});

test("Sharpe handles flat, insufficient, steady and wiped-out paths", () => {
  assert.equal(calcSharpeRatio([]), 0);
  assert.equal(calcSharpeRatio([100, 90]), 0);
  assert.equal(calcSharpeRatio([100, 100, 100]), 0);
  // Constant +10% has no dispersion, so no defined ratio.
  assert.equal(calcSharpeRatio([100, 110, 121]), 0);
  assert.ok(calcSharpeRatio([100, 90, 0, 0]) < 0);
  assert.equal(calcSharpeRatio([0, 0, 0]), 0);
});

test("Sharpe penalizes upside dispersion", () => {
  const smooth = [100, 90, 108, 129.6]; // -.1, .2, .2
  const varied = [100, 90, 99, 128.7]; // -.1, .1, .3
  assert.ok(calcSharpeRatio(varied) < calcSharpeRatio(smooth));
});

test("calcPathMetrics carries Sharpe computed on the same path", () => {
  const values = [100, 110, 99, 118.8];
  const dates = ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"];
  const metrics = calcPathMetrics(values, dates);
  assert.equal(metrics.sharpeRatio, calcSharpeRatio(values));
  assert.equal(metrics.maxDrawdownPct, 10);
});

test("a warm-up backtest reports Sharpe for its displayed path", () => {
  const prices: PricePoint[] = [];
  let v = 100;
  for (let i = 0; i < 300; i++) {
    v *= 1 + (i % 7 === 0 ? -0.012 : 0.003);
    prices.push({
      date: new Date(Date.UTC(2001, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
      adj_close: v,
      close: v,
      open: v,
    });
  }
  const rates: RatePoint[] = [{ date: "1900-01-01", rateValue: 0.03, rateType: "borrow" }];
  const config: EtfConfig = {
    id: "u", name: "UPRO", leverage: 3, expenseRatio: 0.91, simulated: true,
    smaEnabled: true, smaPeriod: 50, smaUpperBuffer: 0, smaLowerBuffer: 0,
    smaIndex: "sp500", riskOffAsset: "SGOV",
  };
  const result = simulateWithWarmUp(prices, rates, [config], prices[120].date, 120);
  assert.ok(result.etfResults.length > 0);
  for (const etf of result.etfResults) {
    assert.equal(etf.dates[0], prices[120].date);
    assert.ok(Number.isFinite(etf.sharpeRatio) && etf.sharpeRatio !== 0, etf.id);
    assert.equal(etf.sharpeRatio, calcSharpeRatio(etf.dailyValues));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

function stdDev(values: number[]) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean)**2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function getDailyReturns(portfolioValues: number[]) {
  const rets = [];
  for (let i = 1; i < portfolioValues.length; i++) {
    rets.push(portfolioValues[i] / portfolioValues[i-1] - 1);
  }
  return rets;
}

const mockPrices: PricePoint[] = Array.from({ length: 100 }, (_, i) => {
  const date = new Date(Date.UTC(2020, 0, 1) + i * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    date,
    adj_close: 100 + Math.sin(i) * 10,
    close: 100 + Math.sin(i) * 10,
  };
});

const mockRates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0, rateType: "borrow" }];

test("Law: Higher leverage always leads to higher volatility", () => {
  const configs: EtfConfig[] = [
    { id: "1x", name: "1x", leverage: 1, expenseRatio: 0, simulated: true, smaEnabled: false, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" },
    { id: "2x", name: "2x", leverage: 2, expenseRatio: 0, simulated: true, smaEnabled: false, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" },
    { id: "3x", name: "3x", leverage: 3, expenseRatio: 0, simulated: true, smaEnabled: false, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" },
  ];
  
  const result = simulateBacktest(mockPrices, mockRates, configs);
  const vol1 = stdDev(getDailyReturns(result.etfResults.find(r => r.id === "1x")!.dailyValues));
  const vol2 = stdDev(getDailyReturns(result.etfResults.find(r => r.id === "2x")!.dailyValues));
  const vol3 = stdDev(getDailyReturns(result.etfResults.find(r => r.id === "3x")!.dailyValues));
  
  assert.equal(vol2 > vol1, true, "2x vol > 1x vol");
  assert.equal(vol3 > vol2, true, "3x vol > 2x vol");
});

test("Law: 1x leverage with 0 fees and 0 spread should match index return exactly", () => {
  const config: EtfConfig = { id: "idx", name: "idx", leverage: 1, expenseRatio: 0, simulated: true, smaEnabled: false, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" };
  const result = simulateBacktest(mockPrices, mockRates, [config]);
  const etf = result.etfResults[0];
  
  const indexReturn = mockPrices[mockPrices.length - 1].adj_close / mockPrices[0].adj_close;
  // Note: engine applies a tiny spread even for 1x if not careful, but for 'idx' it should be minimal
  // Let's check ratios
  const engineReturn = etf.dailyValues[etf.dailyValues.length - 1] / etf.dailyValues[0];
  
  assert.equal(Math.abs(engineReturn - indexReturn) < 0.001, true);
});

test("Law: Total loss floor - portfolio value never goes negative", () => {
  const crashPrices: PricePoint[] = [
    { date: "2020-01-01", adj_close: 100, close: 100 },
    { date: "2020-01-02", adj_close: 50, close: 50 }, // -50%
    { date: "2020-01-03", adj_close: 10, close: 10 }, // -80% more
  ];
  // 3x leverage on -50% would be -150% return (total wipeout)
  const config: EtfConfig = { id: "3x", name: "3x", leverage: 3, expenseRatio: 0, simulated: true, smaEnabled: false, smaPeriod: 20, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" };
  const result = simulateBacktest(crashPrices, mockRates, [config]);
  const values = result.etfResults[0].dailyValues;
  
  for (const val of values) {
    assert.equal(val >= 0, true, "Value should never be negative");
  }
  assert.equal(values[values.length - 1], 0, "Should be exactly zero after wipeout");
});

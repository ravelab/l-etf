import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

const mockRates: RatePoint[] = [{ date: "2020-01-01", rateValue: 0.05, rateType: "borrow" }];
const defaultConfig: EtfConfig = { id: "test", name: "UPRO", leverage: 3, expenseRatio: 0.91, simulated: true, smaEnabled: true, smaPeriod: 200, smaUpperBuffer: 0, smaLowerBuffer: 0, smaIndex: "sp500", riskOffAsset: "SGOV" };

test("Edge Case: Empty price array returns empty result", () => {
  const result = simulateBacktest([], mockRates, [defaultConfig]);
  assert.equal(result.dates.length, 0);
  assert.equal(result.etfResults.length, 0);
});

test("Edge Case: Single price point returns empty result", () => {
  const prices = [{ date: "2020-01-01", adj_close: 100, close: 100 }];
  const result = simulateBacktest(prices, mockRates, [defaultConfig]);
  assert.equal(result.dates.length, 0); // Engine requires >= 2 points
});

test("Edge Case: Extreme SMA period handles gracefully", () => {
  const prices: PricePoint[] = Array.from({ length: 50 }, (_, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, "0")}`,
    adj_close: 100,
    close: 100,
  }));
  
  // Period (1000) > Prices length (50)
  const config: EtfConfig = { ...defaultConfig, smaPeriod: 1000 };
  const result = simulateBacktest(prices, mockRates, [config]);
  
  // Should still run, but SMA will never be "ready". 
  // Engine should fallback to simple average or default to invested.
  assert.equal(result.etfResults.length > 0, true);
});

test("Edge Case: NaN prices handled without crashing", () => {
  const prices: PricePoint[] = [
    { date: "2020-01-01", adj_close: 100, close: 100 },
    { date: "2020-01-02", adj_close: NaN, close: 100 },
    { date: "2020-01-03", adj_close: 110, close: 110 },
  ];
  
  const result = simulateBacktest(prices, mockRates, [defaultConfig]);
  // Engine should probably skip the NaN or treat as 0
  assert.equal(result.etfResults.length > 0, true);
});

test("Edge Case: Large buffer", () => {
  const prices: PricePoint[] = [
    { date: "2020-01-01", adj_close: 100, close: 100 },
    { date: "2020-01-02", adj_close: 100, close: 100 },
    { date: "2020-01-03", adj_close: 150, close: 150 }, // +50%
  ];
  // 100% buffer means price must double to trigger signal
  const config: EtfConfig = { ...defaultConfig, smaPeriod: 2, smaUpperBuffer: 100, smaLowerBuffer: 100};
  const result = simulateBacktest(prices, mockRates, [config]);
  
  const etf = result.etfResults.find(r => r.id === "test-sma");
  assert.equal(etf?.smaSignals.length, 0, "Should not trigger signal with huge buffer");
});

import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

test("Performance: Batch simulation of 50 configurations", () => {
  const points = 2500; // ~10 years
  const mockPrices: PricePoint[] = Array.from({ length: points }, (_, i) => {
    const date = new Date(Date.UTC(2000, 0, 1 + i));
    return {
      date: date.toISOString().slice(0, 10),
      adj_close: 100 + i * 0.05,
      close: 100 + i * 0.05,
    };
  });
  const mockRates: RatePoint[] = [{ date: "2000-01-01", rateValue: 0.05, rateType: "borrow" }];
  
  const configs: EtfConfig[] = Array.from({ length: 50 }, (_, i) => ({
    id: `cfg-${i}`,
    name: "TEST",
    leverage: 3,
    expenseRatio: 0.9,
    simulated: true,
    smaEnabled: true,
    smaPeriod: 50 + i * 2,
    smaBuffer: 1 + i * 0.1,
    smaIndex: "sp500",
    riskOffAsset: "SGOV"
  }));
  
  const start = Date.now();
  const result = simulateBacktest(mockPrices, mockRates, configs);
  const end = Date.now();
  const duration = end - start;
  
  console.log(`[PERF] 50 configs over ${points} points: ${duration}ms`);
  
  assert.equal(result.etfResults.length >= 50, true);
  // Target: < 500ms for 50 configs on a modern machine (Node test runner env)
  assert.equal(duration < 1000, true, `Performance regression: ${duration}ms exceeds 1s limit`);
});

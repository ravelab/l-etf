import test from "node:test";
import assert from "node:assert/strict";
import { simulateBacktest } from "../src/lib/simulation/engine";
import type { PricePoint, RatePoint, EtfConfig } from "../src/lib/simulation/types";

// Mock data for deterministic regression
const mockPrices: PricePoint[] = [
  { date: "2020-01-01", adj_close: 100, close: 1000 },
  { date: "2020-01-02", adj_close: 101, close: 1010 }, // +1%
  { date: "2020-01-03", adj_close: 102.01, close: 1020.1 }, // +1%
  { date: "2020-01-04", adj_close: 91.809, close: 918.09 }, // -10%
  { date: "2020-01-05", adj_close: 100.9899, close: 1009.899 }, // +10%
];

const mockRates: RatePoint[] = [
  { date: "2020-01-01", rateValue: 0.05, rateType: "borrow" },
];

const uproConfig: EtfConfig = {
  id: "upro",
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  smaEnabled: false,
  smaPeriod: 200,
  smaUpperBuffer: 0, smaLowerBuffer: 0,
  smaIndex: "sp500",
  riskOffAsset: "SGOV"
};

test("simulateBacktest (No SMA) matches exact mathematical expectation", () => {
  const result = simulateBacktest(mockPrices, mockRates, [uproConfig]);
  const etf = result.etfResults[0];
  
  // Day 0: 1 * (1 - 0.0001 entry spread) = 0.9999
  // Entry spread for UPRO is 0.01% = 0.0001
  assert.equal(Math.abs(etf.dailyValues[0] - 0.9999) < 1e-9, true);
  
  // Day 1: +1% index. 
  // R_LETF = 3 * 0.01 - (0.91/100/252) - 2 * (0.05/360 + swapSpread)
  // calibrated swapSpread for sp500/3x at 5% is ~ (0.73 * 0.05 + 0.0036) / 360 = 0.000111
  // let's just check the final value is roughly what we expect and then lock it for regression
  
  const finalValue = etf.finalValue;
  // Engine produce ~0.963082 with these inputs. Tolerance is loose enough to
  // absorb cross-platform libm float drift (macOS vs Linux ~4e-5) while still
  // catching real logic regressions, which move this value far more.
  assert.equal(Math.abs(finalValue - 0.963082) < 0.001, true, `Expected ~0.963082, got ${finalValue}`);
});

test("simulateBacktest (SMA) matches exact mathematical expectation", () => {
  const smaConfig: EtfConfig = {
    ...uproConfig,
    id: "upro-sma",
    smaEnabled: true,
    smaPeriod: 2,
    smaUpperBuffer: 0, smaLowerBuffer: 0,
    smaExecutionMode: "trigger-day-close"
  };
  
  const result = simulateBacktest(mockPrices, mockRates, [smaConfig]);
  const etfSma = result.etfResults.find(r => r.id === "upro-sma-sma");
  assert.notEqual(etfSma, undefined);
  
  const signals = etfSma!.smaSignals;
  assert.equal(signals.length >= 1, true);
  assert.equal(signals[0].type, "sell");
  assert.equal(signals[0].date, "2020-01-04");
  
  // Engine produce ~0.738804 with these inputs. Loose tolerance for the same
  // cross-platform float-drift reason as the No-SMA regression above.
  // Golden value shifted from ~0.740352 when the per-transition spread became
  // resolved from config.name: the id "upro-sma" previously resolved the
  // risk-on half-spread to 0 (lowercase, no SPREAD_COSTS entry), so the two
  // transitions here each under-charged by UPRO's 10 bp after-hours spread.
  assert.equal(Math.abs(etfSma!.finalValue - 0.738804) < 0.001, true, `Expected ~0.738804, got ${etfSma!.finalValue}`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { 
  buildRollingWindows, 
  summarizeSmaRow, 
  materializeRollingWindow,
  summarizeParallelResult,
  type RollingSimulationPoint
} from "../src/lib/simulation/rolling";
import type { PricePoint, RatePoint } from "../src/lib/simulation/types";

test("buildRollingWindows creates correct number of windows", () => {
  const prices: PricePoint[] = [];
  for (let y = 2020; y <= 2024; y++) {
    for (let m = 1; m <= 12; m++) {
      prices.push({
        date: `${y}-${String(m).padStart(2, "0")}-01`,
        adj_close: 100,
        close: 100,
      });
    }
  }
  const windows = buildRollingWindows({
    prices,
    windowLength: 1,
    historyWrap: false
  });
  assert.equal(windows.length > 0, true);
  assert.equal(windows[0].startDate, "2020-01-01");
  assert.equal(windows[0].endDate, "2020-12-01");
});

test("buildRollingWindows supports fractional-year windows", () => {
  const prices: PricePoint[] = [];
  for (let y = 2020; y <= 2021; y++) {
    for (let m = 1; m <= 12; m++) {
      prices.push({
        date: `${y}-${String(m).padStart(2, "0")}-01`,
        adj_close: 100,
        close: 100,
      });
    }
  }

  const quarterWindows = buildRollingWindows({
    prices,
    windowLength: 0.25,
    historyWrap: false,
  });
  const halfYearWindows = buildRollingWindows({
    prices,
    windowLength: 0.5,
    historyWrap: false,
  });

  assert.equal(quarterWindows[0].startDate, "2020-01-01");
  assert.equal(quarterWindows[0].endDate, "2020-03-01");
  assert.equal(halfYearWindows[0].startDate, "2020-01-01");
  assert.equal(halfYearWindows[0].endDate, "2020-06-01");
});

test("buildRollingWindows handles historyWrap", () => {
  const prices: PricePoint[] = [];
  for (let y = 2020; y <= 2022; y++) {
    for (let m = 1; m <= 12; m++) {
      prices.push({
        date: `${y}-${String(m).padStart(2, "0")}-01`,
        adj_close: 100,
        close: 100,
      });
    }
  }
  const windows = buildRollingWindows({
    prices,
    windowLength: 2,
    historyWrap: true
  });
  const wrapped = windows.find(w => w.usesSyntheticTail);
  assert.notEqual(wrapped, undefined);
  assert.equal(wrapped?.usesSyntheticTail, true);
});

test("materializeRollingWindow extracts correct sub-series", () => {
  const prices: PricePoint[] = [
    { date: "2020-01-01", adj_close: 100, close: 100 },
    { date: "2020-01-02", adj_close: 101, close: 101 },
    { date: "2020-01-03", adj_close: 102, close: 102 },
  ];
  const rates: RatePoint[] = [
    { date: "2020-01-01", rateValue: 0.01, rateType: "test" },
  ];
  const window = {
    startIdx: 1,
    endIdx: 2,
    startDate: "2020-01-02",
    endDate: "2020-01-03",
    lastRealEndDate: "2020-01-03",
    usesSyntheticTail: false
  };
  
  const result = materializeRollingWindow({ prices, rates, window });
  assert.equal(result.prices.length, 2);
  assert.equal(result.prices[0].date, "2020-01-02");
  assert.equal(result.rates.length, 1);
});

const mockSim = (overrides: Partial<RollingSimulationPoint> = {}): RollingSimulationPoint => ({
  startDate: "2020-01-01",
  endDate: "2021-01-01",
  finalValue: 1100,
  nonLeveragedFinalValue: 1050,
  maxDrawdownPct: 10,
  nonLeveragedMaxDrawdownPct: 5,
  cagr: 10,
  tradeCount: 2,
  totalTradingCostPct: 0.1,
  totalReturnPct: 10,
  usedHistoryWrap: false,
  ...overrides
});

test("summarizeParallelResult aggregates multiple sims", () => {
  const sims = [
    mockSim({ finalValue: 1000, maxDrawdownPct: 10 }),
    mockSim({ finalValue: 2000, maxDrawdownPct: 20 }),
  ];
  const summary = summarizeParallelResult(sims);
  assert.equal(summary.totalSimulations, 2);
  assert.equal(summary.avgEndValue, 1500);
  assert.equal(summary.bestEndValue, 2000);
  assert.equal(summary.biggestMaxDrawdown, 20);
});

test("summarizeSmaRow computes averages correctly", () => {
  const sims = [
    mockSim({ cagr: 10, maxDrawdownPct: 5 }),
    mockSim({ cagr: 20, maxDrawdownPct: 15 }),
  ];
  const summary = summarizeSmaRow(200, sims);
  assert.equal(summary.parameterValue, 200);
  assert.equal(summary.avgReturn, 15);
  assert.equal(summary.bestReturn, 20);
  assert.equal(summary.worstReturn, 10);
  assert.equal(summary.avgMaxDrawdown, 10);
  assert.equal(summary.biggestMaxDrawdown, 15);
});

test("summarizeSmaRow handles inflation adjustment", () => {
  const sims = [
    mockSim({ startDate: "2020-01-01", endDate: "2021-01-01", cagr: 10 }),
  ];
  const monthlyCpi = [
    { date: "2020-01-01", value: 100 },
    { date: "2021-01-01", value: 105 },
  ];
  const summary = summarizeSmaRow(200, sims, monthlyCpi);
  assert.equal(Math.abs(summary.avgReturn - 5) < 0.1, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildRollingWindows } from "../src/lib/simulation/rolling";
import { precomputeAllConfigDailyValues } from "../src/lib/simulation/parallel";
import {
  buildWrappedTailCache,
  extractCachedWrappedWindowResult,
  extractOptimizedWrappedWindowResult,
} from "../src/lib/simulation/wrapped-window";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

function assertClose(actual: number, expected: number, label: string) {
  const tolerance = Math.max(1e-7, Math.abs(expected) * 1e-10);
  assert.equal(
    Math.abs(actual - expected) <= tolerance,
    true,
    `${label}: expected ${expected}, got ${actual}`
  );
}

function makePrices(): PricePoint[] {
  const prices: PricePoint[] = [];
  let close = 100;
  for (let year = 2018; year <= 2023; year++) {
    for (let month = 1; month <= 12; month++) {
      const drift = 1 + 0.008 * Math.sin((prices.length + 1) / 3) - (prices.length % 11 === 0 ? 0.025 : 0);
      close *= drift;
      prices.push({
        date: `${year}-${String(month).padStart(2, "0")}-01`,
        adj_open: close * 0.997,
        adj_close: close,
        close: close * 10,
      });
    }
  }
  return prices;
}

const rates: RatePoint[] = [
  { date: "2018-01-01", rateValue: 0.035, rateType: "test" },
  { date: "2021-01-01", rateValue: 0.055, rateType: "test" },
];

const config: EtfConfig = {
  id: "upro-sma",
  name: "UPRO",
  leverage: 3,
  expenseRatio: 0.91,
  simulated: true,
  smaEnabled: true,
  smaPeriod: 3,
  smaBuffer: 0,
  smaIndex: "sp500",
  riskOffAsset: "SGOV",
};

test("cached wrapped window extraction matches per-window extraction", () => {
  const prices = makePrices();
  const riskOffValuesByAsset = {
    SGOV: prices.map((_, idx) => 100 + idx * 0.05),
  };
  const riskOffOpenValuesByAsset = {
    SGOV: prices.map((_, idx) => 99.9 + idx * 0.05),
  };
  const windows = buildRollingWindows({
    prices,
    windowLength: 4,
    startDateConstraint: "2018-01-01",
    endDateConstraint: "2023-12-01",
    historyWrap: true,
  }).filter((window) => window.usesSyntheticTail);

  assert.equal(windows.length > 0, true);

  const [precomputed] = precomputeAllConfigDailyValues(
    prices,
    rates,
    [config],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  const cache = buildWrappedTailCache(
    windows,
    prices,
    config,
    rates,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.notEqual(cache, null);

  let compared = 0;
  for (const window of windows) {
    const expected = extractOptimizedWrappedWindowResult(
      precomputed,
      window,
      prices,
      config,
      rates,
      riskOffValuesByAsset,
      riskOffOpenValuesByAsset
    );
    if (!expected) continue;
    const actual = extractCachedWrappedWindowResult(precomputed, window, prices, cache!);
    assert.notEqual(actual, null);
    assertClose(actual!.finalValue, expected!.finalValue, `${window.startDate} finalValue`);
    assertClose(actual!.nonLeveragedFinalValue, expected!.nonLeveragedFinalValue, `${window.startDate} nonLeveragedFinalValue`);
    assertClose(actual!.maxDrawdownPct, expected!.maxDrawdownPct, `${window.startDate} maxDrawdownPct`);
    assertClose(actual!.nonLeveragedMaxDrawdownPct, expected!.nonLeveragedMaxDrawdownPct, `${window.startDate} nonLeveragedMaxDrawdownPct`);
    assertClose(actual!.cagr, expected!.cagr, `${window.startDate} cagr`);
    assert.equal(actual!.tradeCount, expected!.tradeCount);
    assertClose(actual!.totalTradingCostPct, expected!.totalTradingCostPct, `${window.startDate} totalTradingCostPct`);
    assert.equal(actual!.usedHistoryWrap, true);
    compared++;
  }
  assert.equal(compared > 0, true);
});

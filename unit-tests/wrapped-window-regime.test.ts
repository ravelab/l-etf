import test from "node:test";
import assert from "node:assert/strict";
import { materializeRollingWindow, type RollingWindow } from "../src/lib/simulation/rolling";
import { precomputeAllConfigDailyValues } from "../src/lib/simulation/parallel";
import {
  buildWrappedTailCache,
  extractCachedWrappedWindowResult,
  extractOptimizedWrappedWindowResult,
} from "../src/lib/simulation/wrapped-window";
import { simulateSingleEtf } from "../src/lib/simulation/engine";
import { generateSmaSignals } from "../src/lib/simulation/sma";
import { buildRateLookup } from "../src/lib/simulation/borrowing-rate";
import { adjustedOpenFromPricePoint } from "../src/lib/utils";
import type { EtfConfig, PricePoint, RatePoint } from "../src/lib/simulation/types";

function assertRelClose(actual: number, expected: number, label: string) {
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-7);
  assert.equal(
    Math.abs(actual - expected) <= tolerance,
    true,
    `${label}: expected ${expected}, got ${actual}`
  );
}

function isoDate(dayOffset: number): string {
  return new Date(Date.UTC(2015, 0, 1) + dayOffset * 86400000).toISOString().slice(0, 10);
}

function pricePoint(dayOffset: number, close: number): PricePoint {
  return { date: isoDate(dayOffset), adj_open: close, adj_close: close, close };
}

const rates: RatePoint[] = [
  { date: "2014-01-01", rateValue: 0.04, rateType: "test" },
];

function makeConfig(overrides: Partial<EtfConfig> = {}): EtfConfig {
  // "FAKE" has no entry in SPREAD_COSTS, so the risk-on spread is zero and the
  // only trading friction left is SGOV's 1bp half-spread — identical in the
  // ground-truth simulation and in the optimized extraction.
  return {
    id: "fake-sma",
    name: "FAKE",
    leverage: 3,
    expenseRatio: 0.91,
    simulated: true,
    smaEnabled: true,
    smaPeriod: 5,
    smaUpperBuffer: 5,
    smaLowerBuffer: 5,
    smaIndex: "sp500",
    riskOffAsset: "SGOV",
    ...overrides,
  };
}

function makeRiskOffValues(prices: PricePoint[]): Partial<Record<EtfConfig["riskOffAsset"], number[]>> {
  return { SGOV: prices.map((_, idx) => 100 * Math.pow(1.0002, idx)) };
}

/**
 * Ground truth for a wrapped window: materialize the full window (real prefix
 * plus synthetic tail) and run the simulation engine over it directly.
 */
function simulateMaterializedWindow(
  prices: PricePoint[],
  window: RollingWindow,
  config: EtfConfig,
  riskOffValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>,
  riskOffOpenValuesByAsset: Partial<Record<EtfConfig["riskOffAsset"], number[]>>
) {
  const materialized = materializeRollingWindow({
    prices,
    rates,
    window,
    warmUpDays: 0,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
  });
  const dates = materialized.prices.map((p) => p.date);
  const closes = materialized.prices.map((p) => p.adj_close);
  const smaCloses = materialized.prices.map((p) => p.close);
  const opens = materialized.prices.map(adjustedOpenFromPricePoint);
  const returns = new Array<number>(closes.length);
  returns[0] = 0;
  for (let i = 1; i < closes.length; i++) {
    returns[i] = (closes[i] - closes[i - 1]) / closes[i - 1];
  }
  const rateLookup = buildRateLookup(materialized.rates);
  const borrowingRates = dates.map((date) => rateLookup.getRate(date));
  return simulateSingleEtf(
    config,
    dates,
    closes,
    returns,
    opens,
    smaCloses,
    borrowingRates,
    materialized.riskOffValuesByAsset,
    materialized.riskOffOpenValuesByAsset
  );
}

/**
 * Scenario for the regime-seeding regression: 100 days rising 0.4%/day, a
 * crash to 100 on day 100 that fires a sell signal, then ~300 days pinned at
 * 100 — strictly inside the ±5% buffer bands, so the hysteretic state stays
 * risk-off through the join. The synthetic tail wraps the constant segment,
 * so the correct tail compounds risk-off (SGOV) returns while a tail seeded
 * risk-on decays under leveraged carry costs.
 */
function makeHoverPrices(): PricePoint[] {
  const prices: PricePoint[] = [];
  let close = 100;
  for (let day = 0; day < 400; day++) {
    if (day > 0 && day < 100) close *= 1.004;
    else if (day === 100) close = 100;
    prices.push(pricePoint(day, close));
  }
  return prices;
}

const hoverPrices = makeHoverPrices();
const hoverWindow: RollingWindow = {
  startIdx: 0,
  endIdx: hoverPrices.length - 1,
  startDate: hoverPrices[0].date,
  endDate: isoDate(hoverPrices.length - 1 + 200),
  lastRealEndDate: hoverPrices[hoverPrices.length - 1].date,
  usesSyntheticTail: true,
  wrapSourceStartIdx: 200,
};

test("wrapped tail seeded from the join regime matches a direct simulation (risk-off at join)", () => {
  const config = makeConfig();
  const riskOffValuesByAsset = makeRiskOffValues(hoverPrices);
  const riskOffOpenValuesByAsset = makeRiskOffValues(hoverPrices);

  const [precomputed] = precomputeAllConfigDailyValues(
    hoverPrices,
    rates,
    [config],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );

  // Scenario sanity: exactly one sell, ~300 days before the last real date.
  assert.equal(precomputed.smaSignals?.length, 1);
  assert.equal(precomputed.smaSignals?.[0].type, "sell");
  assert.equal(precomputed.smaSignals?.[0].date < isoDate(110), true);

  const groundTruth = simulateMaterializedWindow(
    hoverPrices,
    hoverWindow,
    config,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.equal(groundTruth.smaSignals.length, 1);

  const optimized = extractOptimizedWrappedWindowResult(
    precomputed,
    hoverWindow,
    hoverPrices,
    config,
    rates,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.notEqual(optimized, null);
  assertRelClose(optimized!.finalValue, groundTruth.finalValue, "finalValue");
  assertRelClose(optimized!.maxDrawdownPct, groundTruth.maxDrawdownPct, "maxDrawdownPct");
  // The single real sell — no spurious buy at the tail start.
  assert.equal(optimized!.tradeCount, 1);
});

test("cached wrapped tail seeded from the join regime matches ground truth (risk-off at join)", () => {
  const config = makeConfig();
  const riskOffValuesByAsset = makeRiskOffValues(hoverPrices);
  const riskOffOpenValuesByAsset = makeRiskOffValues(hoverPrices);

  const [precomputed] = precomputeAllConfigDailyValues(
    hoverPrices,
    rates,
    [config],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  const groundTruth = simulateMaterializedWindow(
    hoverPrices,
    hoverWindow,
    config,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );

  const cache = buildWrappedTailCache(
    precomputed,
    [hoverWindow],
    hoverPrices,
    config,
    rates,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.notEqual(cache, null);

  const cached = extractCachedWrappedWindowResult(precomputed, hoverWindow, hoverPrices, cache!);
  assert.notEqual(cached, null);
  assertRelClose(cached!.finalValue, groundTruth.finalValue, "finalValue");
  assert.equal(cached!.tradeCount, 1);
});

test("wrapped tail still matches a direct simulation when risk-on at the join", () => {
  // Steadily rising prices: no signals ever, invested through the join.
  const prices: PricePoint[] = [];
  let close = 100;
  for (let day = 0; day < 300; day++) {
    if (day > 0) close *= 1.003;
    prices.push(pricePoint(day, close));
  }
  const window: RollingWindow = {
    startIdx: 0,
    endIdx: prices.length - 1,
    startDate: prices[0].date,
    endDate: isoDate(prices.length - 1 + 150),
    lastRealEndDate: prices[prices.length - 1].date,
    usesSyntheticTail: true,
    wrapSourceStartIdx: 0,
  };
  const config = makeConfig();
  const riskOffValuesByAsset = makeRiskOffValues(prices);
  const riskOffOpenValuesByAsset = makeRiskOffValues(prices);

  const [precomputed] = precomputeAllConfigDailyValues(
    prices,
    rates,
    [config],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.equal(precomputed.smaSignals?.length ?? 0, 0);

  const groundTruth = simulateMaterializedWindow(
    prices,
    window,
    config,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  const optimized = extractOptimizedWrappedWindowResult(
    precomputed,
    window,
    prices,
    config,
    rates,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.notEqual(optimized, null);
  assertRelClose(optimized!.finalValue, groundTruth.finalValue, "finalValue");
  assert.equal(optimized!.tradeCount, 0);
});

test("zero-buffer wrapped windows match a direct simulation (no hysteresis, seed is a no-op)", () => {
  // Oscillating phase produces signals; a clear declining stretch at the end
  // leaves the regime unambiguously risk-off well before the join.
  const prices: PricePoint[] = [];
  for (let day = 0; day < 250; day++) {
    const close = day < 200
      ? 100 * (1 + 0.015 * Math.sin(day / 2))
      : 100 * Math.pow(0.997, day - 199);
    prices.push(pricePoint(day, close));
  }
  const window: RollingWindow = {
    startIdx: 0,
    endIdx: prices.length - 1,
    startDate: prices[0].date,
    endDate: isoDate(prices.length - 1 + 120),
    lastRealEndDate: prices[prices.length - 1].date,
    usesSyntheticTail: true,
    wrapSourceStartIdx: 200,
  };
  const config = makeConfig({ smaUpperBuffer: 0, smaLowerBuffer: 0 });
  const riskOffValuesByAsset = makeRiskOffValues(prices);
  const riskOffOpenValuesByAsset = makeRiskOffValues(prices);

  const [precomputed] = precomputeAllConfigDailyValues(
    prices,
    rates,
    [config],
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  const groundTruth = simulateMaterializedWindow(
    prices,
    window,
    config,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  const optimized = extractOptimizedWrappedWindowResult(
    precomputed,
    window,
    prices,
    config,
    rates,
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset
  );
  assert.notEqual(optimized, null);
  assertRelClose(optimized!.finalValue, groundTruth.finalValue, "finalValue");
  assert.equal(optimized!.tradeCount, groundTruth.smaSignals.length);
});

test("generateSmaSignals seeds the initial invested state and keys its cache by it", () => {
  const dates = Array.from({ length: 30 }, (_, i) => isoDate(i));
  const prices = new Array<number>(30).fill(100);

  // Seeded call first, defaulted call second: if the seed were missing from
  // the cache key, the second call would return the seeded (risk-off) result.
  const seeded = generateSmaSignals(dates, prices, 5, { upper: 5, lower: 5 }, { initialInvested: false });
  const defaulted = generateSmaSignals(dates, prices, 5, { upper: 5, lower: 5 });

  assert.equal(seeded.signals.length, 0);
  assert.equal(defaulted.signals.length, 0);
  assert.equal(seeded.invested.every((v) => v === false), true);
  assert.equal(defaulted.invested.every((v) => v === true), true);
});

test("zero-buffer invested states converge regardless of the seed", () => {
  const dates = Array.from({ length: 60 }, (_, i) => isoDate(i));
  const prices = dates.map((_, i) => 100 * (1 + 0.02 * Math.sin(i / 2)));

  const seededOn = generateSmaSignals(dates, prices, 5, { upper: 0, lower: 0 }, { initialInvested: true });
  const seededOff = generateSmaSignals(dates, prices, 5, { upper: 0, lower: 0 }, { initialInvested: false });

  for (let i = 1; i < dates.length; i++) {
    assert.equal(seededOn.invested[i], seededOff.invested[i], `invested state diverges at index ${i}`);
  }
});

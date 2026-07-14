import test from "node:test";
import assert from "node:assert/strict";
import { runParallelSimulations } from "../src/lib/simulation/parallel";
import type { EtfConfig, PricePoint, RatePoint, SmaComparisonRow } from "../src/lib/simulation/types";

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

function baseConfig(overrides: Partial<EtfConfig>): EtfConfig {
  return {
    id: "cfg",
    name: "cfg",
    leverage: 3,
    expenseRatio: 0.91,
    simulated: true,
    smaEnabled: true,
    smaPeriod: 3,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    smaIndex: "sp500",
    riskOffAsset: "SGOV",
    ...overrides,
  };
}

test("sweep rows carry the true negative param value and are not misclassified as baseline", async () => {
  const prices = makePrices();

  const baseline = baseConfig({
    id: "baseline",
    name: "Baseline",
    smaEnabled: false,
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
  });
  // Mirrors what a shared URL with minT=-5 produces: a negative sweep value
  // encoded into the config id as `buffer--5`.
  const negativeBuffer = baseConfig({
    id: "buffer--5",
    name: "Buffer -5",
    smaUpperBuffer: -5,
    smaLowerBuffer: -5,
  });

  const rows = (await runParallelSimulations({
    prices,
    rates,
    windowLength: 10,
    startDate: prices[0].date,
    endDate: prices[prices.length - 1].date,
    historyWrap: false,
    configs: [baseline, negativeBuffer],
    paramValues: { [baseline.id]: 0, [negativeBuffer.id]: -5 },
    mode: "sweep",
  })) as SmaComparisonRow[];

  assert.equal(rows.length, 2);
  const baselineRow = rows.find((r) => r.parameterValue === 0);
  const negativeRow = rows.find((r) => r.parameterValue === -5);

  assert.notEqual(baselineRow, undefined, "baseline row should report parameterValue 0");
  assert.notEqual(
    negativeRow,
    undefined,
    "negative-buffer row should carry its true parameterValue of -5, not 0"
  );
  assert.notEqual(
    negativeRow!.parameterValue,
    baselineRow!.parameterValue,
    "negative-buffer row must not collapse onto the baseline's parameterValue"
  );
});

test("sweep rows are keyed by explicit param values, independent of the config id scheme", async () => {
  const prices = makePrices();

  // Ids deliberately don't encode the param numerically (old code would
  // parseFloat the id fragment after the first '-' and get NaN here).
  const configA = baseConfig({ id: "cfg-Alpha", name: "Alpha", smaUpperBuffer: 4, smaLowerBuffer: 4 });
  const configB = baseConfig({ id: "cfg-Beta", name: "Beta", smaUpperBuffer: 9, smaLowerBuffer: 9 });

  const rows = (await runParallelSimulations({
    prices,
    rates,
    windowLength: 10,
    startDate: prices[0].date,
    endDate: prices[prices.length - 1].date,
    historyWrap: false,
    configs: [configA, configB],
    paramValues: { [configA.id]: 12.5, [configB.id]: -7.25 },
    mode: "sweep",
  })) as SmaComparisonRow[];

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(Number.isFinite(row.parameterValue), true, "parameterValue must be a finite number, not NaN");
  }
  assert.notEqual(rows.find((r) => r.parameterValue === 12.5), undefined);
  assert.notEqual(rows.find((r) => r.parameterValue === -7.25), undefined);
});

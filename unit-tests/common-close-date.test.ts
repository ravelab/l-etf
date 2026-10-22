import test from "node:test";
import assert from "node:assert/strict";
import { latestCommonCloseDate } from "@/lib/simulation/common-close-date";
import { runParallelBacktest } from "@/lib/simulation/parallel";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import type { PricePoint } from "@/lib/simulation/types";
import { coerceToPricePoints } from "@/lib/mcp/server-data";

const points = (values: number[]): PricePoint[] => values.map((value, i) => ({
  date: `2020-01-0${i + 1}`, close: value, adj_close: value,
}));
const prices = points([100, 102, 104, 80]);
const rates = [{ date: prices[0].date, rateType: "borrow", rateValue: 0.02 }];

test("calibration cutoff uses confirmed shared observations, excluding provisional or invalid closes", () => {
  assert.equal(latestCommonCloseDate([
    [...prices.slice(0, 3), { ...prices[3], source: "yahoo+provisional(adj_close)" }],
    points([100, 102, 104, 105]),
  ], "2020-01-04"), "2020-01-03");
  assert.equal(latestCommonCloseDate([prices, points([100, 102, NaN, 105])], "2020-01-03"), "2020-01-02");
  assert.equal(latestCommonCloseDate([prices, []], "2020-01-04"), undefined);
  assert.equal(latestCommonCloseDate([], "2020-01-04"), undefined);
  const serverPrices = coerceToPricePoints(prices.map((point, i) => ({
    ...point, name: "VOO", source: i === 3 ? "yahoo+provisional(adj_close)" : "tiingo",
  })));
  assert.equal(latestCommonCloseDate([serverPrices, prices], "2020-01-04"), "2020-01-03");
});

test("a new index day cannot create drift against a stale real ETF endpoint", async () => {
  const configs = ["UPRO", "UPRO-real"]
    .map((name) => createPresetEtfConfig(name, ETF_PRESETS[name], { smaEnabled: false }));
  const input = {
    prices, rates, startDate: prices[0].date, endDate: prices[3].date, configs,
    etfPricePointsByName: { UPRO: points([50, 53, 56]) },
  };
  const actual = await runParallelBacktest(input);
  const expected = await runParallelBacktest({ ...input, prices: prices.slice(0, 3), endDate: prices[2].date });
  assert.deepEqual(actual, expected);
  assert.equal(actual.dates.at(-1), "2020-01-03");
  for (const result of actual.etfResults) assert.equal(result.dates.at(-1), "2020-01-03");
});

test("mixed index comparisons stop every series at the last close shared by all real ETFs", async () => {
  const configs = ["UPRO", "UPRO-real", "TQQQ", "TQQQ-real"]
    .map((name) => createPresetEtfConfig(name, ETF_PRESETS[name], { smaEnabled: true, smaPeriod: 2 }));
  const result = await runParallelBacktest({
    prices, rates, startDate: prices[0].date, endDate: prices[3].date, configs,
    pricesByIndex: { sp500: prices, nasdaq100: points([200, 202, 204, 150]) },
    etfPricePointsByName: { UPRO: points([50, 53, 56]), TQQQ: points([100, 103]) },
  });
  assert.equal(result.dates.at(-1), "2020-01-02");
  assert.equal(result.nonLeveragedValues.length, 2);
  for (const etf of result.etfResults) {
    assert.equal(etf.dates.at(-1), "2020-01-02");
    assert.equal(etf.dailyValues.length, 2);
    assert.ok(etf.smaSignals.every((signal) => signal.date <= "2020-01-02"));
  }
});

test("simulated-only runs retain the newest index day even when their real price anchors lag", async () => {
  const result = await runParallelBacktest({
    prices, rates, startDate: prices[0].date, endDate: prices[3].date,
    configs: [createPresetEtfConfig("UPRO", ETF_PRESETS.UPRO, { smaEnabled: false })],
    etfPricePointsByName: { UPRO: points([50, 53, 56]) },
  });
  assert.equal(result.dates.at(-1), "2020-01-04");
  assert.equal(result.etfResults[0].dates.at(-1), "2020-01-04");
});

test("an ETF with no shared closing date fails instead of manufacturing a comparison", async () => {
  await assert.rejects(runParallelBacktest({
    prices, rates, startDate: prices[0].date, endDate: prices[3].date,
    configs: [createPresetEtfConfig("UPRO-real", ETF_PRESETS["UPRO-real"], { smaEnabled: false })],
    etfPricePointsByName: { UPRO: [{ date: "2019-12-31", close: 50, adj_close: 50 }] },
  }), /Not enough shared closing prices/);
});

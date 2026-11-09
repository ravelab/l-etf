import test from "node:test";
import assert from "node:assert/strict";
import { buildBacktestChartSeries } from "@/lib/backtest-chart-series";
import { simulateBacktest } from "@/lib/simulation/engine";
import { createPresetEtfConfig, ETF_PRESETS } from "@/lib/simulation/presets";
import { withSignalRuleLines } from "@/lib/simulation/signal-rules";
import type { PricePoint, RatePoint } from "@/lib/simulation/types";

function isoDates(count: number): string[] {
  const start = Date.UTC(2020, 0, 6);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

test("an extra-strategy line prices its trades off the same LETF as the line it twins", () => {
  // Calm, then a slide: TQQQ (3x) and the index (1x) end far apart, which is
  // what exposed pricing trades off the index instead of the synthetic LETF.
  const dates = isoDates(120);
  const closes = dates.map((_, i) => 100 * (i < 60 ? 1 + 0.002 * i : (1 + 0.002 * 60) * (1 - 0.004 * (i - 60))));
  const prices: PricePoint[] = closes.map((close, i) => ({ date: dates[i], adj_close: close, close, open: close, adj_open: close }));
  const rates: RatePoint[] = [{ date: dates[0], rateType: "borrow", rateValue: 0.02 }];
  const tqqq = createPresetEtfConfig("etf1", ETF_PRESETS.TQQQ, {
    smaEnabled: true, smaPeriod: 20, smaUpperBuffer: 50, smaLowerBuffer: 90, smaVolGate: true, riskOffAsset: "VGSH",
  });
  const configs = withSignalRuleLines([tqqq], ["ndx-sma-vol-9d"]);
  const vgsh = closes.map(() => 100);
  const result = simulateBacktest(prices, rates, configs, {
    riskOffValuesByAsset: { VGSH: vgsh },
    riskOffOpenValuesByAsset: { VGSH: vgsh },
  });
  assert.equal(result.etfResultIdAliases?.["etf2-base"], "etf1-base", "the twin's buy-and-hold line is shared");

  const realTqqq = dates.map((date, i) => ({ date, adj_close: 40 + i * 0.1, close: 40 + i * 0.1 }));
  const series = buildBacktestChartSeries({
    pricesByIndex: { nasdaq100: prices, sp500: [] },
    requiredIndexes: ["nasdaq100"],
    primaryIndex: "nasdaq100",
    resolvedEtfConfigs: configs,
    result,
    initialInvestment: 1,
    etfPricePointsByName: { TQQQ: realTqqq },
    rates,
  });
  assert.deepEqual(series.tradeClosePricesByEtfId["etf2-sma"], series.tradeClosePricesByEtfId["etf1-sma"]);
  assert.deepEqual(series.tradeOpenPricesByEtfId["etf2-sma"], series.tradeOpenPricesByEtfId["etf1-sma"]);
});

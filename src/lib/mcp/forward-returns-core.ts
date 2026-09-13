// `get_forward_sma_returns` orchestration: how the index's distance from its
// SMA related to what happened over the following year.
//
// This is the one analysis on the site that looks forward from a state rather
// than backward over a window, and it had no MCP surface at all. Returns are
// real (CPI-deflated) because the series spans a century and nominal figures
// across that span are not comparable.

import { simulateWithWarmUp } from "@/lib/simulation/engine";
import { findEtfResult } from "@/lib/simulation/result-lookup";
import { buildForwardSmaReturnPoints } from "@/lib/simulation/forward-sma-returns";
import { summarizeForwardBins, type ForwardBinSummary } from "@/lib/forward-sma-bins";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { resolveBacktest, type BacktestInput } from "@/lib/mcp/backtest-config";
import {
  loadBorrowRates,
  loadIndexPrices,
  loadInflation,
  loadRiskOffRawSeries,
} from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";
import { throwIfAborted } from "@/lib/abort";

interface ForwardReturnsResult {
  strategy: string;
  index: string;
  startDate: string;
  endDate: string;
  forwardTradingDays: number;
  observations: number;
  bins: ForwardBinSummary[];
  /** The bin holding the most recent observation is not reported here — this is
   * a historical distribution, not a signal. */
  note: string;
}

const NOTE =
  "Each observation pairs one day's gap between the index and its SMA with the strategy's " +
  "real (CPI-deflated) return over the following window. Observations overlap heavily — " +
  "consecutive days share almost all of their forward window — so bin counts are not " +
  "independent samples and the spread within a bin matters more than its median.";

export async function runForwardSmaReturns(
  input: BacktestInput,
  options?: { forwardTradingDays?: number; signal?: AbortSignal },
): Promise<ForwardReturnsResult> {
  const forwardTradingDays = options?.forwardTradingDays ?? 252;
  const { config, index, startDate, endDate, warmUpDays } = resolveBacktest({
    ...input,
    smaEnabled: true,
  });

  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);
  const [prices, rates, monthlyCpi, rawRiskOff] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
    loadInflation(warmUpStart, endDate),
    loadRiskOffRawSeries(config.riskOffAsset, warmUpStart, endDate),
  ]);
  throwIfAborted(options?.signal);
  if (prices.length < 2) {
    throw new McpToolError(`Not enough price data for ${index} in ${startDate}..${endDate}.`);
  }

  const aligned = alignRiskOffPriceSeries(prices, rawRiskOff);
  const result = simulateWithWarmUp(prices, rates, [config], startDate, warmUpDays, {
    riskOffValuesByAsset: aligned.closeValuesByAsset,
    riskOffOpenValuesByAsset: aligned.openValuesByAsset,
    endDate,
  });

  // The SMA config is expanded into `-base` and `-sma`; this analysis is about
  // the timed path, so select it by id rather than taking the first result.
  const strategyResult = findEtfResult(result, `${config.id}-sma`);
  if (!strategyResult) {
    throw new McpToolError("No SMA strategy result was produced for this configuration.");
  }

  const points = buildForwardSmaReturnPoints({
    indexPrices: prices,
    strategyResult,
    config,
    monthlyCpi,
    startDate,
    endDate,
    forwardTradingDays,
  });
  if (points.length === 0) {
    throw new McpToolError(
      `No forward windows of ${forwardTradingDays} trading days fit inside ${startDate}..${endDate}.`,
    );
  }

  return {
    strategy: config.name,
    index,
    startDate,
    endDate,
    forwardTradingDays,
    observations: points.length,
    bins: summarizeForwardBins(points),
    note: NOTE,
  };
}

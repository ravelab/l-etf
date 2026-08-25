// Server-safe core for `compare_backtests`: run several presets (simulated
// and/or real ETFs, possibly across both indexes) through ONE backtest so their
// paths share dates, then report per-preset metrics. Uses runParallelBacktest
// (main-thread fallback server-side), which aligns risk-off and real-ETF series
// internally — the exact path the /backtesting-tool page uses.

import { runParallelBacktest } from "@/lib/simulation/parallel";
import { findEtfResult } from "@/lib/simulation/engine";
import { getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { getPrices } from "@/lib/db/queries";
import type { EtfConfig, PricePoint } from "@/lib/simulation/types";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { getDefaultSmaBuffer, getDefaultSmaPeriod, DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { makeSweepEtfConfig } from "@/lib/simulation/sweep-items";
import { formatBacktest, type FormattedBacktest } from "@/lib/mcp/format";
import { coerceToPricePoints, loadBorrowRates, loadIndexPrices, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { McpToolError } from "@/lib/mcp/tool-result";

type IndexKey = "sp500" | "nasdaq100";
type RiskOffAsset = EtfConfig["riskOffAsset"];

export interface CompareBacktestsInput {
  presets: string[];
  smaEnabled: boolean;
  smaPeriod?: number;
  smaUpperBuffer?: number;
  smaLowerBuffer?: number;
  riskOffAsset?: RiskOffAsset;
  smaExecutionMode?: NonNullable<EtfConfig["smaExecutionMode"]>;
  startDate?: string;
  endDate?: string;
}

/** Base ETF ticker for a preset key (strips the -real suffix). */
function baseTicker(presetKey: string): string {
  return presetKey.replace(/-real$/, "");
}

export async function runCompareBacktests(input: CompareBacktestsInput): Promise<FormattedBacktest[]> {
  if (input.presets.length === 0) throw new McpToolError("Provide at least one preset.");

  const endDate = input.endDate ?? new Date().toISOString().slice(0, 10);

  const configs: EtfConfig[] = [];
  const indexes = new Set<IndexKey>();
  const tickers = new Set<string>();
  let primaryIndex: IndexKey | null = null;

  for (const key of input.presets) {
    const preset = ETF_PRESETS[key];
    if (!preset) throw new McpToolError(`Unknown preset "${key}".`);
    const index = preset.index;
    indexes.add(index);
    tickers.add(baseTicker(key));
    primaryIndex ??= index;
    const smaPeriod = input.smaPeriod ?? getDefaultSmaPeriod(index);
    configs.push(
      makeSweepEtfConfig(
        { name: preset.name, leverage: preset.leverage, expenseRatio: preset.expenseRatio, simulated: preset.simulated, index },
        {
          id: key,
          name: preset.name,
          smaEnabled: input.smaEnabled,
          smaPeriod,
          smaUpperBuffer: input.smaUpperBuffer ?? getDefaultSmaBuffer(index),
          smaLowerBuffer: input.smaLowerBuffer ?? getDefaultSmaBuffer(index),
          riskOffAsset: input.riskOffAsset ?? DEFAULT_RISK_OFF_ASSET,
          smaExecutionMode: input.smaExecutionMode,
        },
      ),
    );
  }

  const startDate = input.startDate ?? ETF_PRESETS[input.presets[0]].defaultStartDate ?? "1990-01-01";
  const warmUpDays = input.smaEnabled ? Math.max(...configs.map((c) => c.smaPeriod)) : 0;
  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);

  // Per-index prices, borrow rates, real-ETF overlays, and (if SMA) risk-off.
  const pricesByIndex: Record<string, PricePoint[]> = {};
  await Promise.all(
    Array.from(indexes).map(async (idx) => {
      pricesByIndex[idx] = await loadIndexPrices(idx, warmUpStart, endDate);
    }),
  );
  const prices = pricesByIndex[primaryIndex!];
  if (!prices || prices.length < 2) throw new McpToolError("Not enough price data for the requested range.");

  const rates = await loadBorrowRates(warmUpStart, endDate);

  const etfPricePointsByName: Record<string, PricePoint[]> = {};
  await Promise.all(
    Array.from(tickers).map(async (ticker) => {
      const rows = coerceToPricePoints(await getPrices(`etf:${ticker}`, warmUpStart, endDate));
      if (rows.length > 0) etfPricePointsByName[ticker] = rows;
    }),
  );

  let riskOffPricesByAsset;
  if (input.smaEnabled) {
    const assets = Array.from(new Set(configs.map((c) => c.riskOffAsset)));
    riskOffPricesByAsset = await loadRiskOffRawSeriesForAssets(assets, warmUpStart, endDate);
  }

  const result = await runParallelBacktest({
    prices,
    rates,
    startDate,
    endDate,
    configs,
    riskOffPricesByAsset,
    etfPricePointsByName,
    pricesByIndex,
  });
  if (result.dates.length < 2) throw new McpToolError("No backtest results produced.");

  // Select the primary result per preset (-sma when SMA-gated) and attach the
  // no-SMA baseline as a comparison.
  return input.presets
    .map((key) => {
      const primaryId = input.smaEnabled ? `${key}-sma` : key;
      const etf = findEtfResult(result, primaryId);
      if (!etf) return null;
      const noSma = input.smaEnabled ? findEtfResult(result, `${key}-base`) : undefined;
      return formatBacktest(result, etf, noSma);
    })
    .filter((r): r is FormattedBacktest => r != null);
}

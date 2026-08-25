// `run_backtest` — single-configuration backtest of a simulated leveraged-ETF
// strategy over a date range, with optional SMA timing + risk-off switching.
// Routes through `simulateWithWarmUp` → `simulateBacktest`, so the entry/exit
// spread contract in AGENTS.md is preserved (no hand-rolled renormalization).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findEtfResult, simulateWithWarmUp } from "@/lib/simulation/engine";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { formatBacktest, type FormattedBacktest } from "@/lib/mcp/format";
import { resolveBacktest, type BacktestInput } from "@/lib/mcp/backtest-config";
import { loadBorrowRates, loadIndexPrices, loadRiskOffRawSeries } from "@/lib/mcp/server-data";
import {
  indexSchema,
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";
import { z } from "zod/v4";

/**
 * Run a backtest end-to-end from resolved input. Extracted from the tool so it
 * can be unit-tested for parity against the engine.
 */
export async function runBacktestCore(input: BacktestInput): Promise<FormattedBacktest> {
  const { config, index, startDate, endDate, warmUpDays } = resolveBacktest(input);

  const warmUpStart = getMarketDataWarmUpStartDate(startDate, warmUpDays);
  const [allPrices, rates] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
  ]);
  if (allPrices.length < 2) {
    throw new McpToolError(`Not enough price data for ${index} in ${startDate}..${endDate}.`);
  }

  let riskOffValuesByAsset;
  let riskOffOpenValuesByAsset;
  if (config.smaEnabled) {
    const rawRiskOff = await loadRiskOffRawSeries(config.riskOffAsset, warmUpStart, endDate);
    const aligned = alignRiskOffPriceSeries(allPrices, rawRiskOff);
    riskOffValuesByAsset = aligned.closeValuesByAsset;
    riskOffOpenValuesByAsset = aligned.openValuesByAsset;
  }

  const result = simulateWithWarmUp(allPrices, rates, [config], startDate, warmUpDays, {
    riskOffValuesByAsset,
    riskOffOpenValuesByAsset,
    endDate,
  });

  // An SMA config is expanded by the engine into a "-base" (no-SMA) result and
  // a "-sma" result; a plain config keeps its original id. Select the intended
  // primary result and, for SMA runs, pass the baseline through as a comparison.
  const primaryId = config.smaEnabled ? `${config.id}-sma` : config.id;
  const etf = findEtfResult(result, primaryId) ?? result.etfResults[0];
  const noSmaEtf = config.smaEnabled
    ? findEtfResult(result, `${config.id}-base`)
    : undefined;
  if (!etf || result.dates.length < 2) {
    throw new McpToolError("No backtest result produced for this configuration.");
  }
  return formatBacktest(result, etf, noSmaEtf);
}

export function registerRunBacktest(server: McpServer): void {
  server.registerTool(
    "run_backtest",
    {
      title: "Run a leveraged-ETF backtest",
      description:
        "Backtest a simulated leveraged-ETF strategy over a date range and return CAGR, max drawdown, " +
        "Sharpe, final multiple, trade log, and a 1x benchmark. Specify a `preset` (e.g. UPRO, TQQQ) " +
        "or a custom `leverage`+`index`. Enable `smaEnabled` for SMA timing with risk-off switching. " +
        "For educational research only — NOT investment advice.",
      inputSchema: {
        preset: presetSchema.optional(),
        leverage: z.number().min(1).max(3).optional(),
        index: indexSchema.optional(),
        expenseRatio: z.number().min(0).max(5).optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        smaEnabled: z.boolean().optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
      },
    },
    async (args) => {
      try {
        const formatted = await runBacktestCore(args as BacktestInput);
        const summary =
          `${formatted.name} ${formatted.startDate}..${formatted.endDate}: ` +
          `${formatted.finalMultiple.toFixed(2)}x, CAGR ${formatted.cagrPct.toFixed(1)}%, ` +
          `max DD ${formatted.maxDrawdownPct.toFixed(1)}%.`;
        return toolSuccess(summary, withDisclaimer({ backtest: formatted }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

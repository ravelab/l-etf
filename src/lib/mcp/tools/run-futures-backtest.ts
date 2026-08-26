// `run_futures_backtest` — SMA timing strategy expressed with index futures
// (ES/NQ) instead of ETFs: target leverage, optional leverage cap, quarterly
// rolls, per-contract fees, and cash-sweep interest. Mirrors /futures-tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { simulateFuturesSmaStrategy } from "@/lib/simulation/futures";
import { alignRiskOffPriceSeries, getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import type { EtfConfig } from "@/lib/simulation/types";
import { getDefaultSmaBuffer, getDefaultSmaPeriod, DEFAULT_FUTURES_AMOUNT, DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { INDEX_DATE_RANGES } from "@/lib/constants";
import { loadBorrowRates, loadIndexPrices, loadInflation, loadRiskOffRawSeriesForAssets } from "@/lib/mcp/server-data";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { indexSchema, isoDate, riskOffAssetSchema, smaBufferSchema, smaPeriodSchema } from "@/lib/mcp/schemas";

type RiskOffAsset = EtfConfig["riskOffAsset"];

interface FuturesInput {
  index: "sp500" | "nasdaq100";
  targetLeverage: number;
  maxLeverage?: number;
  initialEquity?: number;
  smaPeriod?: number;
  smaBuffer?: number;
  riskOffAsset?: RiskOffAsset;
  maintenanceMarginRate?: number;
  startDate?: string;
  endDate?: string;
}

export async function runFuturesBacktestCore(input: FuturesInput) {
  const { index } = input;
  const smaPeriod = input.smaPeriod ?? getDefaultSmaPeriod(index);
  const smaBuffer = input.smaBuffer ?? getDefaultSmaBuffer(index);
  const riskOffAsset = input.riskOffAsset ?? DEFAULT_RISK_OFF_ASSET;
  const initialEquity = input.initialEquity ?? DEFAULT_FUTURES_AMOUNT;
  const startDate = input.startDate ?? INDEX_DATE_RANGES[index].min;
  const endDate = input.endDate ?? new Date().toISOString().slice(0, 10);
  if (startDate >= endDate) throw new McpToolError("`startDate` must be before `endDate`.");

  const warmUpStart = getMarketDataWarmUpStartDate(startDate, smaPeriod);
  const [prices, rates, monthlyCpi, rawRiskOff] = await Promise.all([
    loadIndexPrices(index, warmUpStart, endDate),
    loadBorrowRates(warmUpStart, endDate),
    loadInflation(warmUpStart, endDate),
    loadRiskOffRawSeriesForAssets([riskOffAsset], warmUpStart, endDate),
  ]);
  if (prices.length < 2) throw new McpToolError(`Not enough price data for ${index} in ${startDate}..${endDate}.`);

  const aligned = alignRiskOffPriceSeries(prices, rawRiskOff);

  const result = simulateFuturesSmaStrategy({
    index,
    prices,
    rates,
    startDate,
    endDate,
    initialEquity,
    targetLeverage: input.targetLeverage,
    maxLeverage: input.maxLeverage,
    smaPeriod,
    smaUpperBuffer: smaBuffer,
    smaLowerBuffer: smaBuffer,
    riskOffAsset,
    riskOffCloseByTicker: aligned.closeValuesByAsset as Record<string, number[]>,
    riskOffOpenByTicker: aligned.openValuesByAsset as Record<string, number[]>,
    maintenanceMarginRate: input.maintenanceMarginRate,
    monthlyCpi,
  });

  const etf = result.etfResult;
  if (etf.dates.length < 2) throw new McpToolError("No futures backtest result produced for this range.");

  return {
    name: etf.name,
    index: result.index,
    startDate: etf.dates[0],
    endDate: etf.dates[etf.dates.length - 1],
    targetLeverage: result.targetLeverage,
    maxLeverage: input.maxLeverage ?? null,
    initialEquity: result.initialEquity,
    finalEquity: etf.finalValue,
    cagrPct: etf.cagr,
    sharpeRatio: etf.sharpeRatio,
    maxDrawdownPct: etf.maxDrawdownPct,
    totalTradingCostPct: etf.totalTradingCostPct,
    numSignals: etf.smaSignals.length,
    futuresTransactions: result.transactions.length,
    avgActualLeverageRiskOn: result.avgActualLeverageRiskOn,
    maxAbsLeverageDeltaRiskOnPct: result.maxAbsLeverageDeltaRiskOnPct,
    riskOffSessionDayCount: result.riskOffSessionDayCount,
    sessionDayCount: result.sessionDayCount,
  };
}

export function registerRunFuturesBacktest(server: McpServer): void {
  server.registerTool(
    "run_futures_backtest",
    {
      title: "Run an index-futures SMA backtest",
      description:
        "Backtest an SMA timing strategy using index futures (ES/NQ) at a chosen target leverage, with " +
        "optional leverage cap, quarterly rolls, per-contract fees, and cash-sweep interest. Returns CAGR, " +
        "drawdown, final equity, realized leverage, and trade counts. NOT investment advice.",
      inputSchema: {
        index: indexSchema,
        targetLeverage: z.number().min(1).max(6),
        maxLeverage: z.number().min(1).max(10).optional(),
        initialEquity: z.number().min(1000).max(1_000_000_000).optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        maintenanceMarginRate: z.number().min(0).max(1).optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
      },
    },
    async (args) => {
      try {
        const out = await runFuturesBacktestCore(args as FuturesInput);
        const summary =
          `${out.name} ${out.startDate}..${out.endDate}: ` +
          `$${Math.round(out.initialEquity).toLocaleString()} → $${Math.round(out.finalEquity).toLocaleString()}, ` +
          `CAGR ${out.cagrPct.toFixed(1)}%, max DD ${out.maxDrawdownPct.toFixed(1)}%.`;
        return toolSuccess(summary, withDisclaimer({ futures: out }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

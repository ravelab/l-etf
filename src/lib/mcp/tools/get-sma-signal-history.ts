// `get_sma_signal_history` — the SMA regime log for one index over a date range:
// every buy/sell crossover, the current regime and how long it has held, and
// whipsaw statistics. `get_sma_signals` answers only "what is the signal today".

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getMarketDataWarmUpStartDate } from "@/lib/fetch-market-data";
import { getDefaultSmaBuffer, getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import { applyCalibratedSmaDefaults, readSmaCalibrationSnapshot } from "@/lib/sma-calibration";
import { getDefaultSmaSignalConfig } from "@/lib/sma-status";
import { summarizeSignalHistory } from "@/lib/mcp/signal-history-core";
import { loadIndexPrices } from "@/lib/mcp/server-data";
import { MAX_SIGNAL_SERIES_ROWS } from "@/lib/mcp/limits";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { indexSchema, isoDate, smaBufferSchema, smaPeriodSchema } from "@/lib/mcp/schemas";

type IndexKey = "sp500" | "nasdaq100";

const DEFAULT_LOOKBACK_YEARS = 10;

/**
 * The band to use when the caller doesn't specify one: the latest calibration
 * snapshot for that index, falling back to the hardcoded defaults — the same
 * precedence `get_sma_signals` applies, so the two tools agree.
 */
async function defaultBand(index: IndexKey): Promise<{ period: number; upper: number; lower: number }> {
  const calibration = await readSmaCalibrationSnapshot();
  const base = calibration
    ? applyCalibratedSmaDefaults({ ...getDefaultSmaSignalConfig(), useCalibratedDefaults: true }, calibration)
    : null;
  if (!base) {
    return {
      period: getDefaultSmaPeriod(index),
      upper: getDefaultSmaBuffer(index),
      lower: getDefaultSmaBuffer(index),
    };
  }
  return index === "nasdaq100"
    ? { period: base.smaNqPeriod, upper: base.smaNqUpperBuffer, lower: base.smaNqLowerBuffer }
    : { period: base.smaSpPeriod, upper: base.smaSpUpperBuffer, lower: base.smaSpLowerBuffer };
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultStartDate(endDate: string): string {
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCFullYear(start.getUTCFullYear() - DEFAULT_LOOKBACK_YEARS);
  return start.toISOString().slice(0, 10);
}

export function registerGetSmaSignalHistory(server: McpServer): void {
  server.registerTool(
    "get_sma_signal_history",
    {
      title: "SMA signal history for an index",
      description:
        "The SMA regime log for one index: every buy/sell crossover in the range, the current regime " +
        "and how long it has held, time in market, and whipsaw stats (flips per year, median days " +
        "between flips). Answers 'when did it last flip' and 'how much does this band whipsaw' without " +
        "running a backtest. Defaults to the calibrated band and the last 10 years. NOT investment advice.",
      inputSchema: {
        index: indexSchema,
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        includeSeries: z.boolean().optional(),
        maxSeriesRows: z.number().int().min(1).max(MAX_SIGNAL_SERIES_ROWS).optional(),
      },
    },
    async (args) => {
      try {
        const index = args.index as IndexKey;
        const band = await defaultBand(index);
        const smaPeriod = args.smaPeriod ?? band.period;
        const smaUpperBuffer = args.smaUpperBuffer ?? band.upper;
        const smaLowerBuffer = args.smaLowerBuffer ?? band.lower;

        const endDate = args.endDate ?? isoToday();
        const startDate = args.startDate ?? defaultStartDate(endDate);
        if (startDate >= endDate) throw new McpToolError("`startDate` must be before `endDate`.");

        // Warm-up rows are loaded so the SMA (and the seeded regime) at the
        // range's first bar match what a backtest over the same band would see.
        const prices = await loadIndexPrices(
          index,
          getMarketDataWarmUpStartDate(startDate, smaPeriod),
          endDate,
        );
        if (prices.length < 2) {
          throw new McpToolError(`Not enough price data for ${index} in ${startDate}..${endDate}.`);
        }

        const history = summarizeSignalHistory({
          prices,
          smaPeriod,
          smaUpperBuffer,
          smaLowerBuffer,
          startDate,
          endDate,
          includeSeries: args.includeSeries === true,
          maxSeriesRows: args.maxSeriesRows ?? MAX_SIGNAL_SERIES_ROWS,
        });

        const summary =
          `${index} SMA ${smaPeriod} (+${smaUpperBuffer}/-${smaLowerBuffer}%): currently ` +
          `${history.current.regime} since ${history.current.since} (${history.current.tradingDays} trading days). ` +
          `${history.stats.flips} flips over ${history.startDate}..${history.endDate}, ` +
          `${history.stats.timeInMarketPct.toFixed(0)}% time in market.`;

        return toolSuccess(summary, {
          history: {
            index,
            config: { smaPeriod, smaUpperBuffer, smaLowerBuffer },
            ...history,
          },
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

// `get_sma_signals` — current SMA buy/sell/hold signal for the S&P 500 and
// Nasdaq-100, given an SMA period/buffer config. Mirrors the server-side logic
// of `src/app/api/sma-signals/route.ts` but reads data directly (no self-HTTP).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPrices } from "@/lib/db/queries";
import { computeSmaSignalSnapshot, getDefaultSmaSignalConfig } from "@/lib/sma-status";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { smaBufferSchema, smaPeriodSchema } from "@/lib/mcp/schemas";

const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

export function registerGetSmaSignals(server: McpServer): void {
  server.registerTool(
    "get_sma_signals",
    {
      title: "Get current SMA signals",
      description:
        "Compute the current SMA timing signal (buy/sell/hold) for the S&P 500 and Nasdaq-100 " +
        "using the given SMA periods and buffers. Defaults to the app's calibrated settings when omitted.",
      inputSchema: {
        smaSpPeriod: smaPeriodSchema.optional(),
        smaSpUpperBuffer: smaBufferSchema.optional(),
        smaSpLowerBuffer: smaBufferSchema.optional(),
        smaNqPeriod: smaPeriodSchema.optional(),
        smaNqUpperBuffer: smaBufferSchema.optional(),
        smaNqLowerBuffer: smaBufferSchema.optional(),
      },
    },
    async (args) => {
      try {
        const defaults = getDefaultSmaSignalConfig();
        const config = {
          ...defaults,
          ...(args.smaSpPeriod != null ? { smaSpPeriod: args.smaSpPeriod } : {}),
          ...(args.smaSpUpperBuffer != null ? { smaSpUpperBuffer: args.smaSpUpperBuffer } : {}),
          ...(args.smaSpLowerBuffer != null ? { smaSpLowerBuffer: args.smaSpLowerBuffer } : {}),
          ...(args.smaNqPeriod != null ? { smaNqPeriod: args.smaNqPeriod } : {}),
          ...(args.smaNqUpperBuffer != null ? { smaNqUpperBuffer: args.smaNqUpperBuffer } : {}),
          ...(args.smaNqLowerBuffer != null ? { smaNqLowerBuffer: args.smaNqLowerBuffer } : {}),
        };

        const endDate = new Date().toISOString().slice(0, 10);
        const startDate = new Date(Date.now() - TWO_YEARS_MS).toISOString().slice(0, 10);
        const [sp500Prices, nasdaqPrices] = await Promise.all([
          getPrices("sp500", startDate, endDate),
          getPrices("nasdaq100", startDate, endDate),
        ]);
        if (sp500Prices.length === 0 || nasdaqPrices.length === 0) {
          throw new McpToolError("Price data is unavailable. The market-data refresh may not have run.");
        }

        const snapshot = computeSmaSignalSnapshot({ sp500Prices, nasdaqPrices, config });
        return toolSuccess(
          `SPX: ${snapshot.sp500.signalLabel}; NDX: ${snapshot.nasdaq100.signalLabel}.`,
          { config, signals: snapshot },
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

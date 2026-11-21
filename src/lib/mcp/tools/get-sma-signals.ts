import type { McpServer } from "@modelcontextprotocol/server";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/annotations";
import { loadCurrentSmaSignals, SmaMarketDataUnavailable } from "@/lib/sma-status";
import { McpToolError, toolError, toolSuccessTyped } from "@/lib/mcp/tool-result";
import { getSmaSignalsOutput } from "@/lib/mcp/output-schemas";
import { smaBufferSchema, smaPeriodSchema, smaVolGateSchema } from "@/lib/mcp/schemas";
import { z } from "zod/v4";
import { signalExitThresholds } from "@/lib/mcp/signal-exit-thresholds";

export function registerGetSmaSignals(server: McpServer): void {
  server.registerTool(
    "get_sma_signals",
    {
      title: "Get current SMA signals",
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        "Compute the current SMA timing signal (buy/sell/hold) for the S&P 500 and Nasdaq-100 " +
        "using the given SMA periods and buffers. Defaults to the site’s inflation-adjusted settings. " +
        "Set smaInflationAdjusted to false to use the nominal calibration. Includes next-close SMA, vol and RSI-brake exit boundaries and constant-decline scenarios for 1–7 trading days; these are not probabilities.",
      inputSchema: z.object({
        smaSpPeriod: smaPeriodSchema.optional(),
        smaSpUpperBuffer: smaBufferSchema.optional(),
        smaSpLowerBuffer: smaBufferSchema.optional(),
        smaNqPeriod: smaPeriodSchema.optional(),
        smaNqUpperBuffer: smaBufferSchema.optional(),
        smaNqLowerBuffer: smaBufferSchema.optional(),
        smaVolGate: smaVolGateSchema.optional(),
        smaInflationAdjusted: z.boolean().optional().describe("Use CPI-adjusted SMA prices and calibration. Defaults to true."),
      }),
      outputSchema: getSmaSignalsOutput,
    },
    async (args) => {
      try {
        const { config, signals: snapshot, sp500Prices, nasdaqPrices } = await loadCurrentSmaSignals(args);
        return toolSuccessTyped(
          `SPX: ${snapshot.sp500.signalLabel}; NDX: ${snapshot.nasdaq100.signalLabel}.`,
          { config, signals: snapshot, exitThresholds: {
            sp500: signalExitThresholds({ index: "sp500", prices: sp500Prices,
              smaPeriod: config.smaSpPeriod, smaLowerBuffer: config.smaSpLowerBuffer, inflationAdjusted: config.smaInflationAdjusted,
              volEnabled: config.smaVolGate === true, volGateRiskOff: snapshot.sp500.volGateRiskOff === true,
              rsiBrakeEnabled: config.smaVolGate === true, rsiBrakeRiskOff: snapshot.sp500.rsiBrakeRiskOff === true }),
            nasdaq100: signalExitThresholds({ index: "nasdaq100", prices: nasdaqPrices,
              smaPeriod: config.smaNqPeriod, smaLowerBuffer: config.smaNqLowerBuffer, inflationAdjusted: config.smaInflationAdjusted,
              volEnabled: config.smaVolGate === true, volGateRiskOff: snapshot.nasdaq100.volGateRiskOff === true,
              rsiBrakeEnabled: config.smaVolGate === true, rsiBrakeRiskOff: snapshot.nasdaq100.rsiBrakeRiskOff === true }),
          } },
        );
      } catch (error) {
        return toolError(error instanceof SmaMarketDataUnavailable
          ? new McpToolError(error.message) : error);
      }
    },
  );
}

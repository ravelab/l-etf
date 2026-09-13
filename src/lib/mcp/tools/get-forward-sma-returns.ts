// `get_forward_sma_returns` — what happened *after* the index sat a given
// distance from its SMA.
//
// Every other tool here looks backward over a window. This one conditions on a
// state and looks forward, which is the shape of the question people actually
// have about a timing rule ("it is 8% below its average — is that the moment to
// buy or to run?"). It matches the raincloud chart on the compare page, sharing
// its bin geometry rather than restating it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/annotations";
import { z } from "zod/v4";
import { runForwardSmaReturns } from "@/lib/mcp/forward-returns-core";
import type { BacktestInput } from "@/lib/mcp/backtest-config";
import { forwardSmaReturnsOutput } from "@/lib/mcp/output-schemas";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { toolError, toolSuccessTyped } from "@/lib/mcp/tool-result";
import {
  indexSchema,
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

export function registerGetForwardSmaReturns(server: McpServer): void {
  server.registerTool(
    "get_forward_sma_returns",
    {
      title: "Forward returns by distance from the SMA",
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        "Bucket history by how far the index sat above or below its SMA, and report the strategy's " +
        "real (inflation-adjusted) return over the following window in each bucket — median, p10/p90 " +
        "and range. Answers what followed a given distance from the line, rather than what a window " +
        "averaged. Observations overlap, so read the spread within a bucket, not just its median. " +
        "NOT investment advice.",
      inputSchema: {
        preset: presetSchema.optional(),
        leverage: z.number().min(1).max(3).optional(),
        index: indexSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        forwardTradingDays: z.number().int().min(5).max(2520).optional(),
      },
      outputSchema: forwardSmaReturnsOutput,
    },
    async (args, extra) => {
      try {
        const result = await runForwardSmaReturns(args as BacktestInput, {
          forwardTradingDays: args.forwardTradingDays,
          signal: extra.signal,
        });
        const deepest = result.bins[0];
        const richest = result.bins[result.bins.length - 1];
        const summary =
          `${result.strategy}: ${result.observations} observations, ` +
          `${result.forwardTradingDays}-day forward real returns by gap to SMA. ` +
          `Deepest bin ${deepest.label}: median ${deepest.medianRealReturnPct.toFixed(1)}% ` +
          `(n=${deepest.count}). Highest bin ${richest.label}: ` +
          `median ${richest.medianRealReturnPct.toFixed(1)}% (n=${richest.count}).`;
        return toolSuccessTyped(summary, withDisclaimer({ ...result }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

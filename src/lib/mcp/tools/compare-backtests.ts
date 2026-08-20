// `compare_backtests` — run several presets (simulated and/or real ETFs, either
// index) through ONE backtest over a shared date range and report per-preset
// metrics. Covers real-vs-simulated comparison and multi-ETF backtests.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { runCompareBacktests } from "@/lib/mcp/backtest-compare-core";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { MAX_SWEEP_CONFIGS } from "@/lib/mcp/limits";
import {
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

export function registerCompareBacktests(server: McpServer): void {
  server.registerTool(
    "compare_backtests",
    {
      title: "Compare multiple backtests",
      description:
        "Backtest several presets over ONE shared date range and compare their metrics. Presets may be " +
        "simulated (UPRO) or real ETFs (UPRO-real) and may span both indexes — ideal for real-vs-simulated " +
        "checks or multi-ETF comparisons. Set `smaEnabled` to gate all with SMA timing. NOT investment advice.",
      inputSchema: {
        presets: z.array(presetSchema).min(1).max(MAX_SWEEP_CONFIGS),
        smaEnabled: z.boolean().optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
      },
    },
    async (args) => {
      try {
        const results = await runCompareBacktests({
          presets: args.presets,
          smaEnabled: args.smaEnabled ?? false,
          smaPeriod: args.smaPeriod,
          smaUpperBuffer: args.smaUpperBuffer,
          smaLowerBuffer: args.smaLowerBuffer,
          riskOffAsset: args.riskOffAsset as never,
          smaExecutionMode: args.smaExecutionMode,
          startDate: args.startDate,
          endDate: args.endDate,
        });
        if (results.length === 0) throw new McpToolError("No backtest results produced.");

        const ranked = [...results].sort((a, b) => b.finalMultiple - a.finalMultiple);
        const summary =
          `${results.length} backtests ${ranked[0].startDate}..${ranked[0].endDate}. ` +
          `Best: ${ranked[0].name} (${ranked[0].finalMultiple.toFixed(2)}x, CAGR ${ranked[0].cagrPct.toFixed(1)}%).`;
        return toolSuccess(summary, withDisclaimer({ backtests: results }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

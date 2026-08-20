// `run_rolling_window_analysis` — evaluate one strategy across every historical
// rolling window of a chosen length, returning the distribution of outcomes
// (avg/best/worst return, drawdowns, win rate) rather than a single path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDefaultWindowLength } from "@/lib/simulation/defaults";
import { resolveBacktest, type BacktestInput } from "@/lib/mcp/backtest-config";
import { runRollingSweep, runRollingWindowPoints } from "@/lib/mcp/sweep-core";
import { summarizeWindowPoints } from "@/lib/mcp/window-distribution";
import { makeProgressReporter } from "@/lib/mcp/progress";
import { formatSweepRow } from "@/lib/mcp/format";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { MAX_RETURNED_WINDOWS, MAX_WINDOW_YEARS, MIN_WINDOW_YEARS } from "@/lib/mcp/limits";
import {
  indexSchema,
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

export function registerRunRollingWindowAnalysis(server: McpServer): void {
  server.registerTool(
    "run_rolling_window_analysis",
    {
      title: "Rolling-window analysis of a strategy",
      description:
        "Evaluate one leveraged-ETF strategy across every historical rolling window of `windowLength` " +
        "years and return the outcome distribution: average/best/worst return, average and worst " +
        "drawdown, and win rate. Use `smaEnabled` for SMA timing. Set `includePercentiles` for the " +
        "outcome distribution (p5..p95 plus a CAGR histogram) or `includeWindows` to also get the " +
        "per-window rows, so you can run your own statistics. NOT investment advice.",
      inputSchema: {
        preset: presetSchema.optional(),
        leverage: z.number().min(1).max(3).optional(),
        index: indexSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        windowLength: z.number().min(MIN_WINDOW_YEARS).max(MAX_WINDOW_YEARS).optional(),
        smaEnabled: z.boolean().optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        includePercentiles: z.boolean().optional(),
        includeWindows: z.boolean().optional(),
        maxWindows: z.number().int().min(1).max(MAX_RETURNED_WINDOWS).optional(),
      },
    },
    async (args, extra) => {
      try {
        const windowLength = args.windowLength ?? getDefaultWindowLength();
        const { config, index, startDate, endDate } = resolveBacktest(args as BacktestInput);
        const onProgress = makeProgressReporter(extra);
        const rows = await runRollingSweep({
          index,
          configs: [config],
          windowLength,
          startDate,
          endDate,
          onProgress,
        });
        if (rows.length === 0) {
          throw new McpToolError("No valid rolling windows for this strategy and range.");
        }
        const stats = formatSweepRow(rows[0].id, config.name, rows[0].stats);

        // The per-window points need a second engine pass (mode "variants"), so
        // only pay for it when the caller actually wants the distribution.
        const wantsDistribution = args.includePercentiles === true || args.includeWindows === true;
        const distribution = wantsDistribution
          ? summarizeWindowPoints(
              await runRollingWindowPoints({ index, config, windowLength, startDate, endDate }),
              { includeWindows: args.includeWindows === true, maxWindows: args.maxWindows },
            )
          : undefined;
        const winRate = stats.winRatePct != null ? `${stats.winRatePct.toFixed(0)}%` : "n/a";
        const summary =
          `${config.name}, ${windowLength}y windows: avg return ${stats.avgReturnPct.toFixed(1)}%, ` +
          `win rate ${winRate}, avg max DD ${stats.avgMaxDrawdownPct.toFixed(1)}%.`;
        return toolSuccess(
          summary,
          withDisclaimer({
            windowLengthYears: windowLength,
            startDate,
            endDate,
            analysis: stats,
            ...(distribution ? { distribution } : {}),
          }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

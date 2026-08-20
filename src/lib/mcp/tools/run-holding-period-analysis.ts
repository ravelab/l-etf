// `run_holding_period_analysis` — how a strategy's outcome distribution changes
// with the holding period. Runs the rolling-window sweep at several window
// lengths and returns the stats per length (mirrors /statistical-analysis).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { resolveBacktest, type BacktestInput } from "@/lib/mcp/backtest-config";
import { runRollingSweep, runRollingWindowPoints } from "@/lib/mcp/sweep-core";
import { summarizeWindowPoints } from "@/lib/mcp/window-distribution";
import { makeStepReporter } from "@/lib/mcp/progress";
import { formatSweepRow } from "@/lib/mcp/format";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { MAX_HOLDING_PERIODS, MAX_WINDOW_YEARS, MIN_WINDOW_YEARS } from "@/lib/mcp/limits";
import {
  indexSchema,
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

const DEFAULT_WINDOW_LENGTHS = [1, 3, 5, 10, 15, 20];

export function registerRunHoldingPeriodAnalysis(server: McpServer): void {
  server.registerTool(
    "run_holding_period_analysis",
    {
      title: "Holding-period analysis",
      description:
        "Show how a strategy's outcome distribution (avg return, win rate, drawdown) changes with the " +
        "holding period, by running the rolling-window analysis at several window lengths (years). " +
        "Set `includePercentiles` to attach each period's outcome distribution (p5..p95 plus a CAGR " +
        "histogram); the raw per-window rows are available from run_rolling_window_analysis, one " +
        "holding period at a time. NOT investment advice.",
      inputSchema: {
        preset: presetSchema.optional(),
        leverage: z.number().min(1).max(3).optional(),
        index: indexSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        windowLengths: z
          .array(z.number().min(MIN_WINDOW_YEARS).max(MAX_WINDOW_YEARS))
          .min(1)
          .max(MAX_HOLDING_PERIODS)
          .optional(),
        smaEnabled: z.boolean().optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        includePercentiles: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const lengths = Array.from(new Set(args.windowLengths ?? DEFAULT_WINDOW_LENGTHS)).sort(
          (a, b) => a - b,
        );
        const { config, index, startDate, endDate } = resolveBacktest(args as BacktestInput);

        // Each holding period is its own sweep, so progress advances a step at
        // a time rather than tracking any single sweep's internal fraction.
        const reportStep = makeStepReporter(extra, lengths.length);
        let completed = 0;

        const byLength = await Promise.all(
          lengths.map(async (windowLength) => {
            const rows = await runRollingSweep({ index, configs: [config], windowLength, startDate, endDate });
            if (rows.length === 0) return null;
            const summary = {
              windowLengthYears: windowLength,
              ...formatSweepRow(rows[0].id, config.name, rows[0].stats),
            };
            if (args.includePercentiles !== true) {
              reportStep?.(++completed, `${completed}/${lengths.length} holding periods`);
              return summary;
            }
            const points = await runRollingWindowPoints({
              index,
              config,
              windowLength,
              startDate,
              endDate,
            });
            reportStep?.(++completed, `${completed}/${lengths.length} holding periods`);
            return { ...summary, distribution: summarizeWindowPoints(points, {}) };
          }),
        );
        const results = byLength.filter((r): r is NonNullable<typeof r> => r != null);
        if (results.length === 0) {
          throw new McpToolError("No valid rolling windows for any requested holding period.");
        }

        const summary =
          `${config.name}: ${results.length} holding periods (${results.map((r) => `${r.windowLengthYears}y`).join(", ")}).`;
        return toolSuccess(summary, withDisclaimer({ strategy: config.name, startDate, endDate, results }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

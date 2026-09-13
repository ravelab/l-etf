// A canned workflow prompt that chains the l-etf tools into a structured
// strategy analysis.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { completeSimulatedPresetName } from "@/lib/mcp/resources";
import { z } from "zod/v4";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analyze_strategy",
    {
      title: "Analyze a leveraged-ETF strategy",
      description:
        "Guide the agent to analyze a leveraged-ETF strategy end-to-end using the l-etf tools.",
      argsSchema: {
        preset: completable(
          z.string().describe("ETF preset to analyze, e.g. UPRO or TQQQ"),
          completeSimulatedPresetName,
        ),
        startDate: z.string().optional().describe("Optional ISO start date (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Optional ISO end date (YYYY-MM-DD)"),
      },
    },
    (args) => {
      const range =
        args.startDate || args.endDate
          ? ` over ${args.startDate ?? "the earliest available date"} to ${args.endDate ?? "today"}`
          : "";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Analyze the ${args.preset} leveraged-ETF strategy${range} using the l-etf tools:\n` +
                `1. Read letf://methodology and letf://data-coverage for context and data freshness.\n` +
                `2. Call get_sma_signals for the current timing signal.\n` +
                `3. Call run_backtest for ${args.preset} both without SMA and with smaEnabled=true, and compare them to the 1x benchmark.\n` +
                `4. Call stress_test_strategy to see what it did in each historical drawdown — an average over rolling windows hides the episodes that matter most for leverage.\n` +
                `5. Use compare_strategies or run_rolling_window_analysis for the distribution of outcomes, not just one path.\n` +
                `6. Only if asked to tune parameters, use optimize_strategy — and report its split-sample rank and neighbourhood, not just the winning cell.\n` +
                `Summarize CAGR, max drawdown, and the risk/reward tradeoff, and say plainly where the strategy failed as well as where it worked. Always include the not-investment-advice disclaimer.`,
            },
          },
        ],
      };
    },
  );
}

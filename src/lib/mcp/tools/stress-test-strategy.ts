// `stress_test_strategy` — run one configuration through every named historical
// drawdown and report what it did in each.
//
// "What would this have done in 2008?" is the first question anyone asks of a
// leveraged strategy, and a rolling-window average cannot answer it: the whole
// point of a timing rule is what it does in the specific episodes that ruin
// un-timed leverage. Cheap, too — each episode is a short backtest.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/annotations";
import { z } from "zod/v4";
import { runStressTest } from "@/lib/mcp/stress-core";
import type { BacktestInput } from "@/lib/mcp/backtest-config";
import { stressTestOutput } from "@/lib/mcp/output-schemas";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { toolError, toolSuccessTyped } from "@/lib/mcp/tool-result";
import {
  indexSchema,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

export function registerStressTestStrategy(server: McpServer): void {
  server.registerTool(
    "stress_test_strategy",
    {
      title: "Run a strategy through historical crises",
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        "Run one configuration through each named historical drawdown (1907, 1929, 1937, 1973-74, " +
        "1987, dot-com, 2008, COVID, 2022) and report, per episode, what the timed strategy did, what " +
        "the same LETF did held straight through, and what the unleveraged index did. Episodes outside " +
        "the index's data are reported as skipped rather than partially run. Each episode is warmed up " +
        "beforehand, so `startedInvested` says whether the rule was already out when it began. " +
        "NOT investment advice.",
      inputSchema: {
        preset: presetSchema.optional(),
        leverage: z.number().min(1).max(3).optional(),
        index: indexSchema.optional(),
        smaEnabled: z.boolean().optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
      },
      outputSchema: stressTestOutput,
    },
    async (args, extra) => {
      try {
        const result = await runStressTest(args as BacktestInput, { signal: extra.signal });
        const worst = result.worstEpisode;
        const worstBuyHold =
          worst.buyAndHoldReturnPct != null
            ? ` (buy-and-hold ${worst.buyAndHoldReturnPct.toFixed(1)}%)`
            : "";
        const skippedNote =
          result.skipped.length > 0
            ? ` ${result.skipped.length} episode(s) outside this index's data were skipped.`
            : "";
        const summary =
          `${result.strategy} through ${result.windowsTested} historical drawdowns. ` +
          `Worst: ${worst.name} at ${worst.strategyReturnPct.toFixed(1)}%${worstBuyHold}.` +
          skippedNote;
        return toolSuccessTyped(summary, withDisclaimer({ ...result }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

// `compare_futures_ladder` — run the whole futures ladder /futures-tool runs,
// including the two-sleeve fund that holds one index per sleeve.
//
// `run_futures_backtest` answers "what does 3x SPX on futures do"; this answers
// "which rung should I be on", which is the question the page exists for and
// the only way to reach the dual-sleeve fund over MCP at all.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/annotations";
import { z } from "zod/v4";
import { runFuturesLadder } from "@/lib/mcp/futures-ladder-core";
import type { EtfConfig } from "@/lib/simulation/types";
import { compareFuturesLadderOutput } from "@/lib/mcp/output-schemas";
import { makeStepReporter } from "@/lib/mcp/progress";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { toolError, toolSuccessTyped } from "@/lib/mcp/tool-result";
import { isoDate, riskOffAssetSchema, smaBufferSchema, smaPeriodSchema } from "@/lib/mcp/schemas";

/** Rungs the plan can produce, so progress has a total before anything runs. */
const MAX_LADDER_RUNGS = 6;

export function registerCompareFuturesLadder(server: McpServer): void {
  server.registerTool(
    "compare_futures_ladder",
    {
      title: "Compare the futures ladder",
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        "Run the site's whole index-futures ladder over one range and rank the rungs: several SPX and " +
        "NDX target leverages plus the two-sleeve fund that runs one index per sleeve, unrebalanced " +
        "except when both are risk-off and one is re-entering. Set `emulationMode` to run only the " +
        "rungs that have a leveraged-ETF twin (3x/2x on each index), which is the comparison that " +
        "isolates the futures-vs-swap cost model. Rungs come from the site's own ladder plan. " +
        "NOT investment advice.",
      inputSchema: {
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        initialEquity: z.number().min(1000).max(1_000_000_000).optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        emulationMode: z.boolean().optional(),
        smaPeriodSp: smaPeriodSchema.optional(),
        smaUpperBufferSp: smaBufferSchema.optional(),
        smaLowerBufferSp: smaBufferSchema.optional(),
        smaPeriodNq: smaPeriodSchema.optional(),
        smaUpperBufferNq: smaBufferSchema.optional(),
        smaLowerBufferNq: smaBufferSchema.optional(),
      },
      outputSchema: compareFuturesLadderOutput,
    },
    async (args, extra) => {
      try {
        const reportStep = makeStepReporter(extra, MAX_LADDER_RUNGS);
        const result = await runFuturesLadder({
          showEmulations: args.emulationMode ?? false,
          startDate: args.startDate,
          endDate: args.endDate,
          initialEquity: args.initialEquity,
          riskOffAsset: args.riskOffAsset as EtfConfig["riskOffAsset"] | undefined,
          bands: {
            sp500: {
              period: args.smaPeriodSp,
              upperBuffer: args.smaUpperBufferSp,
              lowerBuffer: args.smaLowerBufferSp,
            },
            nasdaq100: {
              period: args.smaPeriodNq,
              upperBuffer: args.smaUpperBufferNq,
              lowerBuffer: args.smaLowerBufferNq,
            },
          },
          onProgress: (completed, total) =>
            reportStep?.(completed, `${completed}/${total} futures rungs`),
          signal: extra.signal,
        });

        const best = result.best;
        const summary =
          `${result.rungs.length} futures rungs, ${result.startDate}..${result.endDate}. ` +
          `Best CAGR: ${best.name} at ${best.cagrPct.toFixed(1)}% ` +
          `(max DD ${best.maxDrawdownPct.toFixed(1)}%).` +
          (result.emulationMode ? " Emulation mode: LETF-twin rungs only." : "");
        return toolSuccessTyped(summary, withDisclaimer({ ...result }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

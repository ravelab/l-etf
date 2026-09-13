// `optimize_strategy` — search the joint (SMA period x upper buffer x lower
// buffer) surface over rolling windows and return the best cells, each with the
// evidence needed to judge whether the result is real.
//
// This is the tool the chunked sweep in `sweep-core.ts` exists for: the same
// search used to take ~53 separate `compare_strategies` calls, each reloading
// market data, because breadth was capped at 24 configs.
//
// Guardrails live in `optimize-core.ts` and are on by default. They are not
// decoration: an unguarded optimizer over one price history reliably produces
// parameters that look excellent and mean nothing.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtfConfig } from "@/lib/simulation/types";
import { READ_ONLY_ANNOTATIONS } from "@/lib/mcp/annotations";
import { z } from "zod/v4";
import { getDefaultWindowLength } from "@/lib/simulation/defaults";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { buildAxis, planOptimizationGrid } from "@/lib/mcp/optimize-grid";
import { runOptimization } from "@/lib/mcp/optimize-core";
import { makeProgressReporter } from "@/lib/mcp/progress";
import { optimizeStrategyOutput } from "@/lib/mcp/output-schemas";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccessTyped } from "@/lib/mcp/tool-result";
import { MAX_ROLLING_SWEEP_CONFIGS, MAX_WINDOW_YEARS, MIN_WINDOW_YEARS } from "@/lib/mcp/limits";
import {
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

export function registerOptimizeStrategy(server: McpServer): void {
  server.registerTool(
    "optimize_strategy",
    {
      title: "Search the SMA parameter surface",
      annotations: READ_ONLY_ANNOTATIONS,
      description:
        "Search SMA period and the asymmetric re-entry/exit buffers together over rolling windows, " +
        "ranked by `objective`. Returns the best cells plus two overfitting checks: where the winner " +
        "ranks on a half of history the search never saw (`splitSample`, on by default), and how its " +
        "immediate grid neighbours score — a winner whose neighbours fall away is a fitting artifact, " +
        "not a finding. Results are in-sample by construction; present them as hypotheses. " +
        "NOT investment advice.",
      inputSchema: {
        preset: presetSchema,
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        windowLength: z.number().min(MIN_WINDOW_YEARS).max(MAX_WINDOW_YEARS).optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        minPeriod: smaPeriodSchema.optional(),
        maxPeriod: smaPeriodSchema.optional(),
        periodStep: z.number().int().min(1).max(200).optional(),
        minUpperBuffer: smaBufferSchema.optional(),
        maxUpperBuffer: smaBufferSchema.optional(),
        minLowerBuffer: smaBufferSchema.optional(),
        maxLowerBuffer: smaBufferSchema.optional(),
        bufferStep: z.number().min(0.1).max(30).optional(),
        objective: z.enum(["score", "avgRealCagr", "worstReturn", "sharpeLike"]).optional(),
        splitSample: z.boolean().optional(),
        topN: z.number().int().min(1).max(50).optional(),
      },
      outputSchema: optimizeStrategyOutput,
    },
    async (args, extra) => {
      try {
        const windowLength = args.windowLength ?? getDefaultWindowLength();
        const splitSample = args.splitSample ?? true;
        const objective = args.objective ?? "score";

        const { config: base, index, startDate, endDate } = resolveBacktest({
          preset: args.preset,
          riskOffAsset: args.riskOffAsset as EtfConfig["riskOffAsset"] | undefined,
          smaExecutionMode: args.smaExecutionMode,
          startDate: args.startDate,
          endDate: args.endDate,
        });

        const cells = planOptimizationGrid({
          periods: buildAxis(args.minPeriod ?? 100, args.maxPeriod ?? 250, args.periodStep ?? 25),
          uppers: buildAxis(args.minUpperBuffer ?? 1, args.maxUpperBuffer ?? 4, args.bufferStep ?? 1),
          lowers: buildAxis(args.minLowerBuffer ?? 1, args.maxLowerBuffer ?? 4, args.bufferStep ?? 1),
        });

        // A split-sample run evaluates the whole grid twice, so the breadth cap
        // applies to the total work, not to one pass.
        const passes = splitSample ? 2 : 1;
        if (cells.length * passes > MAX_ROLLING_SWEEP_CONFIGS) {
          throw new McpToolError(
            `This search is ${cells.length} cells over ${passes} pass(es) = ` +
              `${cells.length * passes} simulations, past the limit of ${MAX_ROLLING_SWEEP_CONFIGS}. ` +
              `Widen \`periodStep\`/\`bufferStep\` or narrow a range, then refine around the winner.`,
          );
        }

        const result = await runOptimization({
          base,
          index,
          cells,
          objective,
          windowLength,
          startDate,
          endDate,
          splitSample,
          topN: args.topN ?? 5,
          onProgress: makeProgressReporter(extra),
          signal: extra.signal,
        });

        const b = result.best;
        const oos = result.outOfSample;
        const oosNote = oos
          ? ` Out of sample (${oos.startDate}..${oos.endDate}) it ranked ` +
            `${oos.winnerRank ?? "unplaced"}/${result.gridCells}.`
          : " No split-sample check was run.";
        const summary =
          `${result.gridCells} cells by ${objective}. Best: SMA ${b.smaPeriod}, ` +
          `upper ${b.upperBuffer}% / lower ${b.lowerBuffer}% ` +
          `(avg return ${b.avgReturnPct.toFixed(1)}%, avg max DD ${b.avgMaxDrawdownPct.toFixed(1)}%).` +
          oosNote +
          (result.stability.plateau
            ? " Its neighbourhood is a plateau."
            : " Its neighbours score materially worse — treat it as a spike.");

        return toolSuccessTyped(summary, withDisclaimer({ ...result }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

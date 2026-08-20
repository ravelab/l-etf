// `compare_strategies` — rank several variants of a strategy across historical
// rolling windows: SMA on vs off, risk-off assets, an SMA-period sweep, a
// symmetric buffer sweep, and a 2-D (upper, lower) buffer grid. All variants run
// on the preset's own index.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { EtfConfig } from "@/lib/simulation/types";
import { getDefaultWindowLength } from "@/lib/simulation/defaults";
import { resolveBacktest } from "@/lib/mcp/backtest-config";
import { runRollingSweep } from "@/lib/mcp/sweep-core";
import {
  buildBufferConfigs,
  buildRiskOffConfigs,
  buildSmaOnOffConfigs,
  buildSmaPeriodConfigs,
} from "@/lib/mcp/compare-configs";
import { runAsymmetricBufferGrid } from "@/lib/mcp/buffer-grid-core";
import { formatSweepRow } from "@/lib/mcp/format";
import { makeProgressReporter } from "@/lib/mcp/progress";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { MAX_SWEEP_CONFIGS, MAX_WINDOW_YEARS, MIN_WINDOW_YEARS } from "@/lib/mcp/limits";
import {
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaExecutionModeSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

type RiskOffAsset = EtfConfig["riskOffAsset"];

function buildConfigsForMode(mode: string, base: EtfConfig, args: {
  assets?: string[];
  minPeriod?: number;
  maxPeriod?: number;
  step?: number;
  minBuffer?: number;
  maxBuffer?: number;
  bufferStep?: number;
}): EtfConfig[] {
  if (mode === "sma_on_off") return buildSmaOnOffConfigs(base);
  if (mode === "risk_off_assets") {
    return buildRiskOffConfigs(base, args.assets as RiskOffAsset[] | undefined);
  }
  if (mode === "sma_buffers") {
    return buildBufferConfigs(base, args.minBuffer ?? 0, args.maxBuffer ?? 10, args.bufferStep ?? 1);
  }
  // sma_periods
  return buildSmaPeriodConfigs(base, args.minPeriod ?? 50, args.maxPeriod ?? 250, args.step ?? 25);
}

export function registerCompareStrategies(server: McpServer): void {
  server.registerTool(
    "compare_strategies",
    {
      title: "Compare strategy variants over rolling windows",
      description:
        "Rank variants of a leveraged-ETF strategy across historical rolling windows. Modes: " +
        "`sma_on_off` (SMA vs buy-and-hold), `risk_off_assets` (compare risk-off assets), " +
        "`sma_periods` (sweep SMA periods), `sma_buffers` (sweep symmetric SMA buffers), " +
        "`asymmetric_buffers` (2-D grid over the re-entry `upper` and exit `lower` buffers, ranked by " +
        "`objective`, since the two sides of the band do different jobs). " +
        "All variants use the preset's index. NOT investment advice.",
      inputSchema: {
        preset: presetSchema,
        mode: z.enum([
          "sma_on_off",
          "risk_off_assets",
          "sma_periods",
          "sma_buffers",
          "asymmetric_buffers",
        ]),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
        windowLength: z.number().min(MIN_WINDOW_YEARS).max(MAX_WINDOW_YEARS).optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        smaExecutionMode: smaExecutionModeSchema.optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        assets: z.array(riskOffAssetSchema).optional(),
        minPeriod: smaPeriodSchema.optional(),
        maxPeriod: smaPeriodSchema.optional(),
        step: z.number().int().min(1).max(200).optional(),
        minBuffer: smaBufferSchema.optional(),
        maxBuffer: smaBufferSchema.optional(),
        bufferStep: z.number().min(0.1).max(30).optional(),
        minUpperBuffer: smaBufferSchema.optional(),
        maxUpperBuffer: smaBufferSchema.optional(),
        minLowerBuffer: smaBufferSchema.optional(),
        maxLowerBuffer: smaBufferSchema.optional(),
        gridStep: z.number().min(0.1).max(30).optional(),
        objective: z.enum(["score", "avgRealCagr", "worstReturn", "sharpeLike"]).optional(),
      },
    },
    async (args, extra) => {
      try {
        const windowLength = args.windowLength ?? getDefaultWindowLength();
        const onProgress = makeProgressReporter(extra);
        // Resolve a clean base (no SMA suffix in the name) — the per-mode
        // builders append their own "SMA <period>"/asset labels and set
        // smaEnabled per variant, so the base name must stay unadorned.
        const { config: base, index, startDate, endDate } = resolveBacktest({
          preset: args.preset,
          smaPeriod: args.smaPeriod,
          smaUpperBuffer: args.smaUpperBuffer,
          smaLowerBuffer: args.smaLowerBuffer,
          riskOffAsset: args.riskOffAsset as RiskOffAsset | undefined,
          smaExecutionMode: args.smaExecutionMode,
          startDate: args.startDate,
          endDate: args.endDate,
        });

        // The 2-D grid has its own scoring, baseline handling, and output
        // shape, so it takes a dedicated path rather than the flat ranking.
        if (args.mode === "asymmetric_buffers") {
          const grid = await runAsymmetricBufferGrid({
            base,
            index,
            spec: {
              minUpperBuffer: args.minUpperBuffer ?? 1,
              maxUpperBuffer: args.maxUpperBuffer ?? 4,
              minLowerBuffer: args.minLowerBuffer ?? 1,
              maxLowerBuffer: args.maxLowerBuffer ?? 4,
              gridStep: args.gridStep ?? 1,
            },
            objective: args.objective ?? "score",
            windowLength,
            startDate,
            endDate,
            onProgress,
          });
          const summary =
            `asymmetric_buffers: ${grid.cells} (upper, lower) cells over ${windowLength}y windows, ` +
            `ranked by ${grid.objective}. Best: upper ${grid.best.upperBuffer}% / lower ` +
            `${grid.best.lowerBuffer}% (avg return ${grid.best.avgReturnPct.toFixed(1)}%, ` +
            `avg max DD ${grid.best.avgMaxDrawdownPct.toFixed(1)}%).`;
          return toolSuccess(
            summary,
            withDisclaimer({
              mode: args.mode,
              windowLengthYears: windowLength,
              startDate,
              endDate,
              smaPeriod: base.smaPeriod,
              ...grid,
            }),
          );
        }

        const configs = buildConfigsForMode(args.mode, base, args);
        if (configs.length > MAX_SWEEP_CONFIGS) {
          throw new McpToolError(
            `This comparison would run ${configs.length} strategies, over the limit of ${MAX_SWEEP_CONFIGS}.`,
          );
        }

        const rows = await runRollingSweep({
          index,
          configs,
          windowLength,
          startDate,
          endDate,
          onProgress,
        });
        if (rows.length === 0) {
          throw new McpToolError("No valid rolling windows for these strategies and range.");
        }

        const results = rows
          .map((r) => formatSweepRow(r.id, r.label, r.stats))
          .sort((a, b) => b.avgReturnPct - a.avgReturnPct);

        const best = results[0];
        const bestWinRate = best.winRatePct != null ? `, win rate ${best.winRatePct.toFixed(0)}%` : "";
        const summary =
          `${args.mode}: ${results.length} variants over ${windowLength}y windows. ` +
          `Best avg return: ${best.label} (${best.avgReturnPct.toFixed(1)}%${bestWinRate}).`;
        return toolSuccess(
          summary,
          withDisclaimer({ mode: args.mode, windowLengthYears: windowLength, startDate, endDate, results }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

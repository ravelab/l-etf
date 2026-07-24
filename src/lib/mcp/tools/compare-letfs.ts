// `compare_letfs` — compare several simulated leveraged-ETF presets (UPRO,
// TQQQ, SSO, QLD) across historical rolling windows, returning percentile
// outcome distributions. Mirrors /compare-letfs.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getDefaultWindowLength } from "@/lib/simulation/defaults";
import { runLetfComparison } from "@/lib/mcp/letf-compare-core";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import { toolError, toolSuccess, McpToolError } from "@/lib/mcp/tool-result";
import { MAX_SWEEP_CONFIGS, MAX_WINDOW_YEARS, MIN_WINDOW_YEARS } from "@/lib/mcp/limits";
import {
  isoDate,
  presetSchema,
  riskOffAssetSchema,
  smaBufferSchema,
  smaPeriodSchema,
} from "@/lib/mcp/schemas";

const DEFAULT_PRESETS = ["UPRO", "TQQQ", "SSO", "QLD"];

export function registerCompareLetfs(server: McpServer): void {
  server.registerTool(
    "compare_letfs",
    {
      title: "Compare leveraged ETFs over rolling windows",
      description:
        "Compare simulated leveraged-ETF presets (UPRO, TQQQ, SSO, QLD) across every historical rolling " +
        "window and return percentile outcome distributions (p10/p50/p90 CAGR and final multiple, win " +
        "rate vs 1x, median drawdown). Set `smaEnabled` to gate each with SMA timing + risk-off. " +
        "Simulated series only. NOT investment advice.",
      inputSchema: {
        presets: z.array(presetSchema).min(1).max(MAX_SWEEP_CONFIGS).optional(),
        smaEnabled: z.boolean().optional(),
        windowLength: z.number().min(MIN_WINDOW_YEARS).max(MAX_WINDOW_YEARS).optional(),
        smaPeriod: smaPeriodSchema.optional(),
        smaUpperBuffer: smaBufferSchema.optional(),
        smaLowerBuffer: smaBufferSchema.optional(),
        riskOffAsset: riskOffAssetSchema.optional(),
        startDate: isoDate.optional(),
        endDate: isoDate.optional(),
      },
    },
    async (args) => {
      try {
        const presets = args.presets ?? DEFAULT_PRESETS;
        if (presets.length > MAX_SWEEP_CONFIGS) {
          throw new McpToolError(`Too many presets (${presets.length}); limit is ${MAX_SWEEP_CONFIGS}.`);
        }
        const windowLength = args.windowLength ?? getDefaultWindowLength();
        const rows = await runLetfComparison({
          presets,
          smaEnabled: args.smaEnabled ?? false,
          smaPeriod: args.smaPeriod,
          smaUpperBuffer: args.smaUpperBuffer,
          smaLowerBuffer: args.smaLowerBuffer,
          riskOffAsset: args.riskOffAsset as never,
          windowLength,
          startDate: args.startDate,
          endDate: args.endDate,
        });

        const best = rows[0];
        const summary =
          `${rows.length} LETFs over ${windowLength}y windows${args.smaEnabled ? " (SMA-gated)" : " (buy & hold)"}. ` +
          `Best median CAGR: ${best.preset} (${best.cagrPct.p50.toFixed(1)}%).`;
        return toolSuccess(
          summary,
          withDisclaimer({ windowLengthYears: windowLength, smaEnabled: args.smaEnabled ?? false, results: rows }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

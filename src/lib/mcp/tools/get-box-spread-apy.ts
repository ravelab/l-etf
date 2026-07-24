// `get_box_spread_apy` — SPX box-spread implied financing APY, fetched live from
// boxtrades.com (mirrors the /box-trades page). Useful as a low-risk borrowing-
// rate benchmark for leveraged strategies.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { fetchSpxBoxtradesApyReport } from "@/lib/boxtrades";
import { toolError, toolSuccess } from "@/lib/mcp/tool-result";

export function registerGetBoxSpreadApy(server: McpServer): void {
  server.registerTool(
    "get_box_spread_apy",
    {
      title: "Get SPX box-spread APY",
      description:
        "Fetch SPX box-spread implied financing APYs (a low-risk synthetic borrowing rate) live from " +
        "boxtrades.com. `minDays` filters to contracts with at least that many days to expiry.",
      inputSchema: {
        minDays: z.number().int().min(0).max(3650).optional(),
      },
    },
    async (args) => {
      try {
        const minDays = args.minDays ?? 365;
        const report = await fetchSpxBoxtradesApyReport(minDays);
        const summary =
          `${report.contracts.length} SPX box contracts (≥${minDays} days)` +
          (report.asOf ? ` as of ${report.asOf}.` : ".");
        return toolSuccess(summary, {
          symbol: "SPX",
          source: "https://www.boxtrades.com/",
          minDays,
          asOf: report.asOf,
          sizeModel: report.sizeModel,
          contracts: report.contracts,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

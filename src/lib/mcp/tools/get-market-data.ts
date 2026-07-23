// `get_market_data` — raw underlying data the other tools consume: index total-
// return prices, LETF borrowing rates, or CPI/inflation, over a bounded date
// range. Returns are capped to keep payloads manageable.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { getBorrowRate, getInflation, getPrices } from "@/lib/db/queries";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { indexSchema, isoDate } from "@/lib/mcp/schemas";

const MAX_ROWS = 2000;

/** Return at most the last `MAX_ROWS` rows, preserving chronological order. */
function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  if (rows.length <= MAX_ROWS) return { rows, truncated: false };
  return { rows: rows.slice(rows.length - MAX_ROWS), truncated: true };
}

export function registerGetMarketData(server: McpServer): void {
  server.registerTool(
    "get_market_data",
    {
      title: "Get market data",
      description:
        "Fetch raw market data over a date range: index total-return prices (`prices`, requires " +
        "`index`), LETF borrowing rates (`borrowRates`), or CPI inflation (`inflation`). " +
        `Up to ${MAX_ROWS} rows are returned (most recent kept); narrow the range for finer detail.`,
      inputSchema: {
        dataType: z.enum(["prices", "borrowRates", "inflation"]),
        index: indexSchema.optional(),
        startDate: isoDate,
        endDate: isoDate,
      },
    },
    async (args) => {
      try {
        if (args.startDate >= args.endDate) {
          throw new McpToolError("`startDate` must be before `endDate`.");
        }

        if (args.dataType === "prices") {
          if (!args.index) throw new McpToolError("`index` is required when dataType is `prices`.");
          const rows = await getPrices(args.index, args.startDate, args.endDate);
          const { rows: capped, truncated } = capRows(rows);
          return toolSuccess(
            `${capped.length} price rows for ${args.index}${truncated ? " (truncated)" : ""}.`,
            { dataType: args.dataType, index: args.index, truncated, rows: capped },
          );
        }

        if (args.dataType === "borrowRates") {
          const rows = await getBorrowRate(args.startDate, args.endDate);
          const { rows: capped, truncated } = capRows(rows);
          return toolSuccess(`${capped.length} borrow-rate rows${truncated ? " (truncated)" : ""}.`, {
            dataType: args.dataType,
            truncated,
            rows: capped,
          });
        }

        const rows = await getInflation(args.startDate, args.endDate);
        const { rows: capped, truncated } = capRows(rows);
        return toolSuccess(`${capped.length} inflation rows${truncated ? " (truncated)" : ""}.`, {
          dataType: args.dataType,
          truncated,
          rows: capped,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

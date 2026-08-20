// `get_precomputed_analysis` — serve the site's canonical precomputed runs.
//
// Every tool page ships a generated snapshot; returning those costs no engine
// time, so the common questions ("how has UPRO+SMA done", "which risk-off asset
// wins") are answerable instantly and the strict per-IP budget on the heavy
// sweep tools stays free for genuinely novel configurations.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { withDisclaimer } from "@/lib/mcp/disclaimer";
import {
  getSnapshot,
  listSnapshots,
  SNAPSHOT_ANALYSES,
  type SnapshotAnalysis,
} from "@/lib/mcp/snapshot-core";
import { toolError, toolSuccess } from "@/lib/mcp/tool-result";

export function registerGetPrecomputedAnalysis(server: McpServer): void {
  server.registerTool(
    "get_precomputed_analysis",
    {
      title: "Get a precomputed analysis snapshot",
      description:
        "Return the site's canonical precomputed run for a tool page — no simulation, so it is instant " +
        "and does not consume the heavy-tool rate limit. Call with no arguments to list what is " +
        "available and how fresh each snapshot is. Snapshots use the site's own inputs and are " +
        "generated with history wrap enabled, unlike the live tools; re-run the matching tool when you " +
        "need a like-for-like or custom-input number. NOT investment advice.",
      inputSchema: {
        analysis: z.enum(SNAPSHOT_ANALYSES).optional(),
      },
    },
    async (args) => {
      try {
        if (!args.analysis) {
          const available = await listSnapshots();
          return toolSuccess(
            `${available.length} precomputed analyses available (as of ${available[0]?.snapshotEndDate ?? "n/a"}). ` +
              `Call again with \`analysis\` set to one of: ${available.map((a) => a.analysis).join(", ")}.`,
            { available },
          );
        }

        const snapshot = await getSnapshot(args.analysis as SnapshotAnalysis);
        const summary =
          `${snapshot.title} — precomputed through ${snapshot.snapshotEndDate} ` +
          `(generated ${snapshot.generatedAt.slice(0, 10)}).`;
        return toolSuccess(summary, withDisclaimer({ snapshot }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

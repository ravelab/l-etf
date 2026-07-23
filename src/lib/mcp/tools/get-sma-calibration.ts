// `get_sma_calibration` — return the precomputed SMA calibration snapshot
// (best-performing SMA period/buffer per index from the last offline
// calibration run). This is a cached lookup, not a live sweep.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readSmaCalibrationSnapshot } from "@/lib/sma-calibration";
import { McpToolError, toolError, toolSuccess } from "@/lib/mcp/tool-result";
import { withDisclaimer } from "@/lib/mcp/disclaimer";

export function registerGetSmaCalibration(server: McpServer): void {
  server.registerTool(
    "get_sma_calibration",
    {
      title: "Get SMA calibration snapshot",
      description:
        "Return the precomputed best SMA period/buffer per index from the latest offline calibration " +
        "run. A cached lookup, not a live sweep — for a live parameter sweep use compare_strategies.",
    },
    async () => {
      try {
        const snapshot = await readSmaCalibrationSnapshot();
        if (!snapshot) {
          throw new McpToolError("SMA calibration snapshot is unavailable. Run `npm run calibrate-sma`.");
        }
        return toolSuccess("SMA calibration snapshot.", withDisclaimer({ calibration: snapshot }));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

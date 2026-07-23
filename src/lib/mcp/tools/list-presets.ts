// `list_presets` — discovery tool. Lets an agent learn the available ETF
// presets, risk-off assets, and simulation defaults before calling the other
// tools. Read-only; no market data touched.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import { DEFAULT_RISK_OFF_ASSET, getDefaultSmaBuffer, getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import { toolError, toolSuccess } from "@/lib/mcp/tool-result";

export function registerListPresets(server: McpServer): void {
  server.registerTool(
    "list_presets",
    {
      title: "List ETF presets and defaults",
      description:
        "List the leveraged-ETF presets, risk-off assets, and default SMA settings available to " +
        "the other l-etf tools. Call this first to discover valid `preset` and `riskOffAsset` values.",
    },
    async () => {
      try {
        const presets = Object.entries(ETF_PRESETS).map(([key, p]) => ({
          key,
          name: p.name,
          leverage: p.leverage,
          index: p.index,
          simulated: p.simulated,
          expenseRatio: p.expenseRatio,
          description: p.description,
        }));
        const data = {
          presets,
          riskOffAssets: RISK_OFF_ASSET_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          defaults: {
            riskOffAsset: DEFAULT_RISK_OFF_ASSET,
            sma: {
              sp500: { period: getDefaultSmaPeriod("sp500"), buffer: getDefaultSmaBuffer("sp500") },
              nasdaq100: { period: getDefaultSmaPeriod("nasdaq100"), buffer: getDefaultSmaBuffer("nasdaq100") },
            },
          },
        };
        return toolSuccess(`${presets.length} presets available.`, data);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

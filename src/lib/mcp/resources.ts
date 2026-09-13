// Read-only MCP resources that ground an agent's answers in the app's own
// methodology and data freshness, rather than invented finance lore.

import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPriceDateBounds } from "@/lib/db/queries";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { DISCLAIMER } from "@/lib/mcp/disclaimer";
import { McpToolError } from "@/lib/mcp/tool-result";

const METHODOLOGY = `# l-etf simulation methodology (summary)

- **Simulated LETFs** apply daily leverage (2x/3x) to the underlying index's
  total-return series, then deduct the fund expense ratio and a modeled daily
  financing (borrowing) cost. They are models, not the real ETFs.
- **Trading costs**: an entry spread is compounded from the start of a window;
  an exit spread is deducted from the final value only.
- **SMA timing**: when enabled, the strategy holds the LETF while the index is
  above its SMA (times an upper buffer) and switches to the chosen risk-off
  asset when it falls below (times a lower buffer). Execution defaults to
  next-day-open fills.
- **Risk-off assets** may be single tickers (SGOV, VGSH, GLDM, BRK.B, VOO, QQQ)
  or composites (e.g. BRK.B+GLDM+VGSH) held in equal weight.
- **Rolling-window analysis** evaluates a strategy across every historical
  window of a chosen length to show a distribution of outcomes, not a single path.

${DISCLAIMER}`;

function presetNames(): string[] {
  return Object.keys(ETF_PRESETS);
}

function matchingPresets(names: string[], typed: string): string[] {
  const prefix = typed.trim().toLowerCase();
  if (prefix === "") return names;
  return names.filter((name) => name.toLowerCase().startsWith(prefix));
}

/**
 * Every preset name matching what has been typed, `-real` series included.
 * Case-insensitive because a user types `upro`, and the catalog is small enough
 * to filter in full.
 */
function completePresetName(typed: string): string[] {
  return matchingPresets(presetNames(), typed);
}

/**
 * Simulated presets only. The `-real` series are real-ETF price history, which
 * `run_backtest` and the rolling-window tools reject outright — offering one as
 * a completion would only ever produce a tool error.
 */
export function completeSimulatedPresetName(typed: string): string[] {
  const simulated = presetNames().filter((name) => ETF_PRESETS[name]?.simulated);
  return matchingPresets(simulated, typed);
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "methodology",
    "letf://methodology",
    {
      title: "l-etf methodology & assumptions",
      description: "How the simulated leveraged-ETF backtests, trading costs, SMA timing, and risk-off switching work.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: METHODOLOGY }],
    }),
  );

  server.registerResource(
    "data-coverage",
    "letf://data-coverage",
    {
      title: "Market data coverage",
      description: "Earliest and latest available dates per index, so an agent knows how fresh the numbers are.",
      mimeType: "application/json",
    },
    async (uri) => {
      const [sp500, nasdaq100] = await Promise.all([
        getPriceDateBounds("sp500"),
        getPriceDateBounds("nasdaq100"),
      ]);
      const payload = { sp500, nasdaq100, retrievedAt: new Date().toISOString() };
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // One preset's parameters, without spending a tool call on the whole catalog.
  // The completion is what lets a client offer the vocabulary instead of making
  // a user guess whether the 2x Nasdaq series is called QLD or NDX2.
  server.registerResource(
    "preset",
    new ResourceTemplate("letf://preset/{name}", {
      list: undefined,
      complete: { name: completePresetName },
    }),
    {
      title: "Leveraged-ETF preset",
      description:
        "Parameters for one preset (leverage, index, expense ratio, launch/default start date).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const requested = Array.isArray(variables.name) ? variables.name[0] : variables.name;
      const preset = typeof requested === "string" ? ETF_PRESETS[requested] : undefined;
      if (!preset) {
        throw new McpToolError(
          `Unknown preset "${String(requested)}". Known presets: ${presetNames().join(", ")}.`,
        );
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(preset, null, 2),
          },
        ],
      };
    },
  );
}

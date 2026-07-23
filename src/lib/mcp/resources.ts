// Read-only MCP resources that ground an agent's answers in the app's own
// methodology and data freshness, rather than invented finance lore.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPriceDateBounds } from "@/lib/db/queries";
import { DISCLAIMER } from "@/lib/mcp/disclaimer";

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
}

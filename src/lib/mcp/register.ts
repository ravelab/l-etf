// Central wiring: register every l-etf MCP tool, resource, and prompt on a
// server instance. Imported by the route handler and by tests.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerListPresets } from "@/lib/mcp/tools/list-presets";
import { registerGetMarketData } from "@/lib/mcp/tools/get-market-data";
import { registerGetSmaSignals } from "@/lib/mcp/tools/get-sma-signals";
import { registerGetSmaCalibration } from "@/lib/mcp/tools/get-sma-calibration";
import { registerRunBacktest } from "@/lib/mcp/tools/run-backtest";
import { registerCompareBacktests } from "@/lib/mcp/tools/compare-backtests";
import { registerRunRollingWindowAnalysis } from "@/lib/mcp/tools/run-rolling-window-analysis";
import { registerRunHoldingPeriodAnalysis } from "@/lib/mcp/tools/run-holding-period-analysis";
import { registerCompareStrategies } from "@/lib/mcp/tools/compare-strategies";
import { registerCompareLetfs } from "@/lib/mcp/tools/compare-letfs";
import { registerGetBoxSpreadApy } from "@/lib/mcp/tools/get-box-spread-apy";
import { registerRunFuturesBacktest } from "@/lib/mcp/tools/run-futures-backtest";
import { registerResources } from "@/lib/mcp/resources";
import { registerPrompts } from "@/lib/mcp/prompts";

export function registerAll(server: McpServer): void {
  registerListPresets(server);
  registerGetMarketData(server);
  registerGetSmaSignals(server);
  registerGetSmaCalibration(server);
  registerRunBacktest(server);
  registerCompareBacktests(server);
  registerRunRollingWindowAnalysis(server);
  registerRunHoldingPeriodAnalysis(server);
  registerCompareStrategies(server);
  registerCompareLetfs(server);
  registerGetBoxSpreadApy(server);
  registerRunFuturesBacktest(server);
  registerResources(server);
  registerPrompts(server);
}

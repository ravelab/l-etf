// Resolve MCP backtest input into a concrete `EtfConfig` plus the date range
// and SMA warm-up the engine needs. Kept separate from the tool so it can be
// unit-tested in isolation and reused by the heavy tools later.

import type { EtfConfig } from "@/lib/simulation/types";
import { ETF_PRESETS } from "@/lib/simulation/presets";
import { getDefaultSmaBuffer, getDefaultSmaPeriod, DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { DEFAULT_SMA_EXECUTION_MODE } from "@/lib/input-normalization";
import { INDEX_DATE_RANGES } from "@/lib/constants";
import { McpToolError } from "@/lib/mcp/tool-result";

type RiskOffAsset = EtfConfig["riskOffAsset"];
type IndexKey = "sp500" | "nasdaq100";

export interface BacktestInput {
  preset?: string;
  leverage?: number;
  index?: IndexKey;
  expenseRatio?: number;
  startDate?: string;
  endDate?: string;
  smaEnabled?: boolean;
  smaPeriod?: number;
  smaUpperBuffer?: number;
  smaLowerBuffer?: number;
  riskOffAsset?: RiskOffAsset;
  smaExecutionMode?: NonNullable<EtfConfig["smaExecutionMode"]>;
}

export interface ResolvedBacktest {
  config: EtfConfig;
  index: IndexKey;
  startDate: string;
  endDate: string;
  warmUpDays: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Turn loosely-specified backtest input into a fully-resolved simulation
 * config. Throws `McpToolError` for unsupported combinations so the caller
 * returns a clean tool error.
 */
export function resolveBacktest(input: BacktestInput): ResolvedBacktest {
  let leverage: number;
  let expenseRatio: number;
  let index: IndexKey;
  let label: string;
  let presetDefaultStart: string | undefined;

  if (input.preset) {
    const preset = ETF_PRESETS[input.preset];
    if (!preset) throw new McpToolError(`Unknown preset "${input.preset}".`);
    if (!preset.simulated) {
      throw new McpToolError(
        `Preset "${input.preset}" is a real-ETF series; run_backtest only supports simulated series. ` +
          `Use the simulated variant (e.g. "${input.preset.replace(/-real$/, "")}").`,
      );
    }
    leverage = preset.leverage;
    expenseRatio = preset.expenseRatio;
    index = preset.index;
    label = preset.name;
    presetDefaultStart = preset.defaultStartDate;
  } else {
    if (input.leverage == null || input.index == null) {
      throw new McpToolError("Provide either `preset` or both `leverage` and `index`.");
    }
    leverage = input.leverage;
    index = input.index;
    expenseRatio = input.expenseRatio ?? 0.9;
    label = `${leverage}x ${index === "nasdaq100" ? "NDX" : "SPX"}`;
  }

  const indexStart = INDEX_DATE_RANGES[index]?.min;
  const startDate = input.startDate ?? presetDefaultStart ?? indexStart;
  const endDate = input.endDate ?? todayIso();
  if (!startDate) throw new McpToolError(`No start date available for index "${index}".`);
  if (startDate >= endDate) throw new McpToolError("`startDate` must be before `endDate`.");

  const smaEnabled = input.smaEnabled ?? false;
  const smaPeriod = input.smaPeriod ?? getDefaultSmaPeriod(index);
  const smaUpperBuffer = input.smaUpperBuffer ?? getDefaultSmaBuffer(index);
  const smaLowerBuffer = input.smaLowerBuffer ?? getDefaultSmaBuffer(index);
  const riskOffAsset = input.riskOffAsset ?? DEFAULT_RISK_OFF_ASSET;

  const config: EtfConfig = {
    id: "mcp",
    name: smaEnabled ? `${label} SMA ${smaPeriod}` : label,
    leverage,
    expenseRatio,
    simulated: true,
    smaEnabled,
    smaPeriod,
    smaUpperBuffer,
    smaLowerBuffer,
    smaIndex: index,
    smaExecutionMode: input.smaExecutionMode ?? DEFAULT_SMA_EXECUTION_MODE,
    riskOffAsset,
  };

  return {
    config,
    index,
    startDate,
    endDate,
    warmUpDays: smaEnabled ? smaPeriod : 0,
  };
}

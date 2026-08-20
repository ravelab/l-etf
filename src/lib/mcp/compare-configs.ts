// Build the EtfConfig lists for each `compare_strategies` mode from a resolved
// base config. Delegates to the shared sweep item-builders in
// `@/lib/simulation/sweep-items` (the same ones the compare pages use) so config
// construction has a single source of truth across the browser and the MCP tool.

import type { EtfConfig } from "@/lib/simulation/types";
import { RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import {
  buildRiskOffVariantConfigs,
  buildSmaPeriodSweepItems,
  buildSymmetricBufferSweepItems,
  makeAsymmetricSweepItem,
  makeSweepEtfConfig,
  type SweepPresetDef,
} from "@/lib/simulation/sweep-items";
import { planCoarseGrid } from "@/lib/simulation/buffer-grid-search";
import { MAX_BUFFER_GRID_CELLS, MAX_BUFFER_STEPS, MAX_SMA_PERIOD_STEPS } from "@/lib/mcp/limits";
import { McpToolError } from "@/lib/mcp/tool-result";

type RiskOffAsset = EtfConfig["riskOffAsset"];

function presetDefFromBase(base: EtfConfig): SweepPresetDef {
  return {
    name: base.name,
    leverage: base.leverage,
    expenseRatio: base.expenseRatio,
    simulated: base.simulated,
    index: base.smaIndex,
  };
}

/** SMA-enabled vs the same LETF held buy-and-hold. */
export function buildSmaOnOffConfigs(base: EtfConfig): EtfConfig[] {
  const preset = presetDefFromBase(base);
  return [
    makeSweepEtfConfig(preset, {
      id: "baseline",
      name: `${base.name} (No SMA)`,
      smaEnabled: false,
      smaPeriod: base.smaPeriod,
      smaUpperBuffer: 0,
      smaLowerBuffer: 0,
      riskOffAsset: base.riskOffAsset,
      simulated: true,
      smaExecutionMode: base.smaExecutionMode,
    }),
    makeSweepEtfConfig(preset, {
      id: "sma",
      name: `${base.name} (SMA ${base.smaPeriod})`,
      smaEnabled: true,
      smaPeriod: base.smaPeriod,
      smaUpperBuffer: base.smaUpperBuffer,
      smaLowerBuffer: base.smaLowerBuffer,
      riskOffAsset: base.riskOffAsset,
      smaExecutionMode: base.smaExecutionMode,
    }),
  ];
}

/** SMA strategy across each candidate risk-off asset, plus a no-SMA baseline. */
export function buildRiskOffConfigs(base: EtfConfig, assets?: RiskOffAsset[]): EtfConfig[] {
  const candidates =
    assets && assets.length > 0
      ? assets
      : (RISK_OFF_ASSET_OPTIONS.map((o) => o.value) as RiskOffAsset[]);
  return buildRiskOffVariantConfigs({
    preset: presetDefFromBase(base),
    baselineRiskOffAsset: base.riskOffAsset,
    assets: candidates,
    smaPeriod: base.smaPeriod,
    upperBuffer: base.smaUpperBuffer,
    lowerBuffer: base.smaLowerBuffer,
    smaExecutionMode: base.smaExecutionMode,
  }).map((v) => v.config);
}

/** Sweep SMA periods from min to max (inclusive) by step, plus a no-SMA baseline. */
export function buildSmaPeriodConfigs(
  base: EtfConfig,
  minPeriod: number,
  maxPeriod: number,
  step: number,
): EtfConfig[] {
  if (step <= 0) throw new McpToolError("`step` must be a positive integer.");
  if (minPeriod > maxPeriod) throw new McpToolError("`minPeriod` must be ≤ `maxPeriod`.");
  const count = Math.floor((maxPeriod - minPeriod) / step) + 1;
  if (count > MAX_SMA_PERIOD_STEPS) {
    throw new McpToolError(
      `SMA-period sweep of ${count} steps exceeds the limit of ${MAX_SMA_PERIOD_STEPS}. Widen \`step\` or narrow the range.`,
    );
  }
  return buildSmaPeriodSweepItems({
    preset: presetDefFromBase(base),
    riskOffAsset: base.riskOffAsset,
    minSmaPeriod: minPeriod,
    maxSmaPeriod: maxPeriod,
    stepSize: step,
    upperBuffer: base.smaUpperBuffer,
    lowerBuffer: base.smaLowerBuffer,
    smaExecutionMode: base.smaExecutionMode,
  }).map((i) => i.config);
}

/** Sweep symmetric SMA buffers from min to max (inclusive) by step, plus baseline. */
export function buildBufferConfigs(
  base: EtfConfig,
  minBuffer: number,
  maxBuffer: number,
  step: number,
): EtfConfig[] {
  if (step <= 0) throw new McpToolError("`bufferStep` must be positive.");
  if (minBuffer > maxBuffer) throw new McpToolError("`minBuffer` must be ≤ `maxBuffer`.");
  const count = Math.floor((maxBuffer - minBuffer) / step) + 1;
  if (count > MAX_BUFFER_STEPS) {
    throw new McpToolError(
      `Buffer sweep of ${count} steps exceeds the limit of ${MAX_BUFFER_STEPS}. Widen \`bufferStep\` or narrow the range.`,
    );
  }
  return buildSymmetricBufferSweepItems({
    preset: presetDefFromBase(base),
    riskOffAsset: base.riskOffAsset,
    smaPeriod: base.smaPeriod,
    minBuffer,
    maxBuffer,
    fineStep: step,
    smaExecutionMode: base.smaExecutionMode,
  }).map((i) => i.config);
}

export interface AsymmetricBufferGridSpec {
  minUpperBuffer: number;
  maxUpperBuffer: number;
  minLowerBuffer: number;
  maxLowerBuffer: number;
  gridStep: number;
}

export interface AsymmetricBufferCell {
  upperBuffer: number;
  lowerBuffer: number;
}

export interface AsymmetricBufferConfigs {
  /** Grid cells followed by the no-SMA baseline (last). */
  configs: EtfConfig[];
  /** Config id → the (upper, lower) pair it evaluates. Excludes the baseline. */
  grid: Map<string, AsymmetricBufferCell>;
}

/**
 * Plan the 2-D (upper, lower) buffer grid the /compare-threshold-strategies
 * page searches, as one flat pass. Uses the page's own `planCoarseGrid` so the
 * axis rounding matches, and `makeAsymmetricSweepItem` so the configs do too.
 */
export function buildAsymmetricBufferConfigs(
  base: EtfConfig,
  spec: AsymmetricBufferGridSpec,
): AsymmetricBufferConfigs {
  if (spec.gridStep <= 0) throw new McpToolError("`gridStep` must be positive.");
  if (spec.minUpperBuffer > spec.maxUpperBuffer) {
    throw new McpToolError("`minUpperBuffer` must be ≤ `maxUpperBuffer`.");
  }
  if (spec.minLowerBuffer > spec.maxLowerBuffer) {
    throw new McpToolError("`minLowerBuffer` must be ≤ `maxLowerBuffer`.");
  }

  const points = planCoarseGrid({
    minUpper: spec.minUpperBuffer,
    maxUpper: spec.maxUpperBuffer,
    minLower: spec.minLowerBuffer,
    maxLower: spec.maxLowerBuffer,
    coarseStep: spec.gridStep,
  });
  if (points.length === 0) throw new McpToolError("The buffer grid is empty.");
  if (points.length > MAX_BUFFER_GRID_CELLS) {
    throw new McpToolError(
      `This buffer grid is ${points.length} cells, over the limit of ${MAX_BUFFER_GRID_CELLS}. ` +
        `Widen \`gridStep\` or narrow the upper/lower ranges, then refine around the best cell with a second call.`,
    );
  }

  const preset = presetDefFromBase(base);
  const grid = new Map<string, AsymmetricBufferCell>();
  const configs: EtfConfig[] = [];
  for (const point of points) {
    const { config } = makeAsymmetricSweepItem({
      preset,
      riskOffAsset: base.riskOffAsset,
      smaPeriod: base.smaPeriod,
      upper: point.upper,
      lower: point.lower,
      variant: "coarse",
      smaExecutionMode: base.smaExecutionMode,
    });
    // A degenerate range can plan the same cell twice; keep one config per id so
    // the sweep rows stay 1:1 with the grid.
    if (grid.has(config.id)) continue;
    grid.set(config.id, { upperBuffer: point.upper, lowerBuffer: point.lower });
    configs.push(config);
  }

  configs.push(
    makeSweepEtfConfig(preset, {
      id: "baseline",
      name: `${base.name} (No SMA)`,
      smaEnabled: false,
      smaPeriod: base.smaPeriod,
      smaUpperBuffer: 0,
      smaLowerBuffer: 0,
      riskOffAsset: base.riskOffAsset,
      simulated: true,
      smaExecutionMode: base.smaExecutionMode,
    }),
  );

  return { configs, grid };
}

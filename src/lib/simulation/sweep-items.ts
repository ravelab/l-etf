// Shared, side-effect-free builders for the compare-page rolling sweeps.
//
// Single source of truth for how sweep EtfConfigs are constructed, used by the
// three `"use client"` compare pages (compare-sma-strategies,
// compare-riskoff-assets, compare-threshold-strategies) AND by the MCP
// `compare_strategies` tool. Centralizing the object construction keeps the
// config field set from drifting between the browser and server code paths.
//
// `smaExecutionMode` is optional throughout: leaving it unset makes the engine
// fall back to DEFAULT_SMA_EXECUTION_MODE ("next-day-open"), which is what the
// compare pages intend. The MCP tools pass it explicitly so an agent can test
// whether a result survives a different fill assumption.

import type { EtfConfig } from "@/lib/simulation/types";
import { getDefaultSmaPeriod } from "@/lib/simulation/defaults";

type IndexKey = "sp500" | "nasdaq100";
type RiskOffAsset = EtfConfig["riskOffAsset"];
type SmaExecutionMode = NonNullable<EtfConfig["smaExecutionMode"]>;

export interface SweepPresetDef {
  name: string;
  leverage: number;
  expenseRatio: number;
  simulated: boolean;
  index: IndexKey;
}

export interface SweepItem {
  paramValue: number;
  config: EtfConfig;
}

export interface LabeledSweepConfig {
  label: string;
  config: EtfConfig;
}

/** Construct one sweep EtfConfig from a preset plus per-config overrides. */
export function makeSweepEtfConfig(
  preset: SweepPresetDef,
  opts: {
    id: string;
    name: string;
    smaEnabled: boolean;
    smaPeriod: number;
    smaUpperBuffer: number;
    smaLowerBuffer: number;
    riskOffAsset: RiskOffAsset;
    /** Baselines force simulated:true regardless of the preset. */
    simulated?: boolean;
    /** Left undefined, the engine applies DEFAULT_SMA_EXECUTION_MODE. */
    smaExecutionMode?: SmaExecutionMode;
  },
): EtfConfig {
  return {
    id: opts.id,
    name: opts.name,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: opts.simulated ?? preset.simulated,
    smaEnabled: opts.smaEnabled,
    smaPeriod: opts.smaPeriod,
    smaUpperBuffer: opts.smaUpperBuffer,
    smaLowerBuffer: opts.smaLowerBuffer,
    smaIndex: preset.index,
    riskOffAsset: opts.riskOffAsset,
    ...(opts.smaExecutionMode ? { smaExecutionMode: opts.smaExecutionMode } : {}),
  };
}

/** No-SMA baseline whose period is the index default (SMA + risk-off pages). */
function defaultPeriodBaseline(
  preset: SweepPresetDef,
  riskOffAsset: RiskOffAsset,
  smaExecutionMode?: SmaExecutionMode,
): EtfConfig {
  return makeSweepEtfConfig(preset, {
    id: "baseline",
    name: `${preset.name} (No SMA)`,
    smaEnabled: false,
    smaPeriod: getDefaultSmaPeriod(preset.index),
    smaUpperBuffer: 0,
    smaLowerBuffer: 0,
    riskOffAsset,
    simulated: true,
    smaExecutionMode,
  });
}

/**
 * compare-sma-strategies: baseline first, then one SMA config per period in
 * [minSmaPeriod, maxSmaPeriod] stepped by stepSize.
 */
export function buildSmaPeriodSweepItems(p: {
  preset: SweepPresetDef;
  riskOffAsset: RiskOffAsset;
  minSmaPeriod: number;
  maxSmaPeriod: number;
  stepSize: number;
  upperBuffer: number;
  lowerBuffer: number;
  smaExecutionMode?: SmaExecutionMode;
}): SweepItem[] {
  const items: SweepItem[] = [
    { paramValue: 0, config: defaultPeriodBaseline(p.preset, p.riskOffAsset, p.smaExecutionMode) },
  ];
  for (let sma = p.minSmaPeriod; sma <= p.maxSmaPeriod; sma += p.stepSize) {
    items.push({
      paramValue: sma,
      config: makeSweepEtfConfig(p.preset, {
        id: `sma-${sma}`,
        name: `${p.preset.name} SMA ${sma}`,
        smaEnabled: true,
        smaPeriod: sma,
        smaUpperBuffer: p.upperBuffer,
        smaLowerBuffer: p.lowerBuffer,
        riskOffAsset: p.riskOffAsset,
        smaExecutionMode: p.smaExecutionMode,
      }),
    });
  }
  return items;
}

/**
 * compare-riskoff-assets: one SMA config per candidate risk-off asset, then the
 * no-SMA baseline last (labeled "baseline").
 */
export function buildRiskOffVariantConfigs(p: {
  preset: SweepPresetDef;
  baselineRiskOffAsset: RiskOffAsset;
  assets: RiskOffAsset[];
  smaPeriod: number;
  upperBuffer: number;
  lowerBuffer: number;
  smaExecutionMode?: SmaExecutionMode;
}): LabeledSweepConfig[] {
  const variants: LabeledSweepConfig[] = p.assets.map((asset) => ({
    label: asset,
    config: makeSweepEtfConfig(p.preset, {
      id: `riskoff-${asset}`,
      name: `${p.preset.leverage}x SMA ${p.smaPeriod} (${asset})`,
      smaEnabled: true,
      smaPeriod: p.smaPeriod,
      smaUpperBuffer: p.upperBuffer,
      smaLowerBuffer: p.lowerBuffer,
      riskOffAsset: asset,
      smaExecutionMode: p.smaExecutionMode,
    }),
  }));
  return [
    ...variants,
    {
      label: "baseline",
      config: defaultPeriodBaseline(p.preset, p.baselineRiskOffAsset, p.smaExecutionMode),
    },
  ];
}

/**
 * compare-threshold-strategies: baseline first (period = the given smaPeriod,
 * not the index default), then a symmetric upper=lower buffer sweep.
 */
export function buildSymmetricBufferSweepItems(p: {
  preset: SweepPresetDef;
  riskOffAsset: RiskOffAsset;
  smaPeriod: number;
  minBuffer: number;
  maxBuffer: number;
  fineStep: number;
  smaExecutionMode?: SmaExecutionMode;
}): SweepItem[] {
  const items: SweepItem[] = [
    {
      paramValue: 0,
      config: makeSweepEtfConfig(p.preset, {
        id: "baseline",
        name: `${p.preset.name} (No SMA)`,
        smaEnabled: false,
        smaPeriod: p.smaPeriod,
        smaUpperBuffer: 0,
        smaLowerBuffer: 0,
        riskOffAsset: p.riskOffAsset,
        simulated: true,
        smaExecutionMode: p.smaExecutionMode,
      }),
    },
  ];
  for (let buf = p.minBuffer; buf <= p.maxBuffer + 1e-9; buf += p.fineStep) {
    const rt = Math.round(buf * 1000) / 1000;
    items.push({
      paramValue: rt,
      config: makeSweepEtfConfig(p.preset, {
        id: `buffer-${rt}`,
        name: `${p.preset.name} SMA ${p.smaPeriod} Buffer ${rt}%`,
        smaEnabled: true,
        smaPeriod: p.smaPeriod,
        smaUpperBuffer: rt,
        smaLowerBuffer: rt,
        riskOffAsset: p.riskOffAsset,
        smaExecutionMode: p.smaExecutionMode,
      }),
    });
  }
  return items;
}

/** Encode an (upper, lower) buffer pair as a single sweep parameter value. */
export function encodeAsymBuffer(upper: number, lower: number): number {
  return Math.round(upper * 100) * 10000 + Math.round(lower * 100);
}

/**
 * compare-threshold-strategies: one asymmetric (upper ≠ lower) buffer config.
 * `variant` distinguishes the coarse first pass from the fine refinement pass.
 */
export function makeAsymmetricSweepItem(p: {
  preset: SweepPresetDef;
  riskOffAsset: RiskOffAsset;
  smaPeriod: number;
  upper: number;
  lower: number;
  variant: "coarse" | "fine";
  smaExecutionMode?: SmaExecutionMode;
}): SweepItem {
  const encoded = encodeAsymBuffer(p.upper, p.lower);
  return {
    paramValue: encoded,
    config: makeSweepEtfConfig(p.preset, {
      id: `asym-${encoded}`,
      name: `${p.preset.name} SMA ${p.smaPeriod} U${p.upper}/L${p.lower} (${p.variant})`,
      smaEnabled: true,
      smaPeriod: p.smaPeriod,
      smaUpperBuffer: p.upper,
      smaLowerBuffer: p.lower,
      riskOffAsset: p.riskOffAsset,
      smaExecutionMode: p.smaExecutionMode,
    }),
  };
}

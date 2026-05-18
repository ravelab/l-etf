import { CONSTANT_NASDAQ100_START_DATE, CONSTANT_SP500_START_DATE, INDEX_DATE_RANGES } from "../constants";
import {
  DEFAULT_RISK_OFF_ASSET,
  getDefaultSmaBuffer,
  getDefaultSmaPeriod,
} from "./defaults";
import type { EtfConfig } from "./types";

export interface EtfPreset {
  name: string;
  leverage: number;
  expenseRatio: number;
  index: "sp500" | "nasdaq100";
  description: string;
  launchDate: string;
  simulated: boolean;
  /** Default start date for simulated presets (real presets use launchDate). */
  defaultStartDate?: string;
}

type PresetKey = keyof typeof ETF_PRESETS;

export const ETF_PRESETS: Record<string, EtfPreset> = {
  UPRO: {
    name: "UPRO",
    leverage: 3,
    expenseRatio: 0.91,
    index: "sp500",
    description: "Simulated 3x SPX (from index data)",
    launchDate: "",
    simulated: true,
    defaultStartDate: CONSTANT_SP500_START_DATE,
  },
  SSO: {
    name: "SSO",
    leverage: 2,
    expenseRatio: 0.91,
    index: "sp500",
    description: "Simulated 2x SPX (from index data)",
    launchDate: "",
    simulated: true,
    defaultStartDate: CONSTANT_SP500_START_DATE,
  },
  TQQQ: {
    name: "TQQQ",
    leverage: 3,
    expenseRatio: 0.88,
    index: "nasdaq100",
    description: "Simulated 3x NDX (from index data)",
    launchDate: "",
    simulated: true,
    defaultStartDate: CONSTANT_NASDAQ100_START_DATE,
  },
  QLD: {
    name: "QLD",
    leverage: 2,
    expenseRatio: 0.95,
    index: "nasdaq100",
    description: "Simulated 2x NDX (from index data)",
    launchDate: "",
    simulated: true,
    defaultStartDate: CONSTANT_NASDAQ100_START_DATE,
  },
  "UPRO-real": {
    name: "UPRO-real",
    leverage: 3,
    expenseRatio: 0.91,
    index: "sp500",
    description: "ProShares UltraPro S&P 500 (3x)",
    launchDate: "",
    simulated: false,
  },
  "SSO-real": {
    name: "SSO-real",
    leverage: 2,
    expenseRatio: 0.91,
    index: "sp500",
    description: "ProShares Ultra S&P 500 (2x)",
    launchDate: "",
    simulated: false,
  },
  "TQQQ-real": {
    name: "TQQQ-real",
    leverage: 3,
    expenseRatio: 0.88,
    index: "nasdaq100",
    description: "ProShares UltraPro QQQ (3x Nasdaq)",
    launchDate: "",
    simulated: false,
  },
  "QLD-real": {
    name: "QLD-real",
    leverage: 2,
    expenseRatio: 0.95,
    index: "nasdaq100",
    description: "ProShares Ultra QQQ (2x Nasdaq)",
    launchDate: "",
    simulated: false,
  },
} as const;

export const DEFAULT_COMBO_PRESET = "UPRO+TQQQ";

const COMBO_PRESETS: Record<string, string[]> = {
  [DEFAULT_COMBO_PRESET]: ["UPRO", "TQQQ"],
};

export function getValidPresetKey(key: string, fallbackKey: PresetKey = "UPRO"): string {
  if (key in ETF_PRESETS || key in COMBO_PRESETS) return key;
  return fallbackKey;
}

export function isComboPreset(key: string): boolean {
  return key in COMBO_PRESETS;
}

export function getComboSubPresets(key: string): EtfPreset[] {
  const subKeys = COMBO_PRESETS[key];
  if (!subKeys) return [];
  return subKeys.map((k) => ETF_PRESETS[k]).filter(Boolean);
}

export function resolvePresetContext(key: string, fallbackKey: PresetKey = "UPRO") {
  const validKey = getValidPresetKey(key, fallbackKey);
  const isCombo = isComboPreset(validKey);
  const selectedPreset = ETF_PRESETS[validKey] ?? ETF_PRESETS[fallbackKey];
  const comboSubs = isCombo ? getComboSubPresets(validKey) : null;
  const comboLabels = comboSubs
    ? ([comboSubs[0]?.name ?? "Primary", comboSubs[1]?.name ?? "Secondary"] as const)
    : null;

  return {
    isCombo,
    selectedPreset,
    comboSubs,
    comboLabels,
  };
}

export function resolvePresetSelection(
  value: string | null | undefined,
  fallbackKey: PresetKey = "UPRO",
): { key: string; preset: EtfPreset; isCombo: boolean } | null {
  if (!value) return null;
  const validKey = getValidPresetKey(value, fallbackKey) as PresetKey;
  const preset = ETF_PRESETS[validKey];
  if (!preset) return null;
  return {
    key: validKey,
    preset,
    isCombo: isComboPreset(validKey),
  };
}

export function getActivePreset(
  selectedPreset: EtfPreset,
  comboSubs: EtfPreset[] | null,
  subPresetIdx?: number,
): EtfPreset {
  return subPresetIdx != null && comboSubs ? comboSubs[subPresetIdx] : selectedPreset;
}

export function getComboEffectiveDateRange(key: string): { min: string; max: string } {
  const subs = COMBO_PRESETS[key];
  if (!subs) return INDEX_DATE_RANGES.sp500;
  const ranges = subs.map((k) => INDEX_DATE_RANGES[ETF_PRESETS[k].index]);
  return {
    min: ranges.reduce((acc, r) => (r.min < acc ? r.min : acc), ranges[0].min),
    max: ranges.reduce((acc, r) => (acc < r.max ? acc : r.max), "9999-12-31"),
  };
}

function presetSortKey(p: EtfPreset): number {
  const simOrder = p.simulated ? 0 : 1;
  const indexOrder = p.index === "sp500" ? 0 : 1;
  const leverageOrder = p.leverage === 3 ? 0 : p.leverage === 2 ? 1 : 2;
  return simOrder * 100 + indexOrder * 10 + leverageOrder;
}

const SINGLE_PRESET_OPTIONS = Object.entries(ETF_PRESETS)
  .sort(([, a], [, b]) => presetSortKey(a) - presetSortKey(b))
  .map(([key, p]) => ({
    value: key,
    label: `${p.name} (${p.leverage}x ${p.index === "sp500" ? "SPX" : "NDX"})`,
  }));

const COMBO_PRESET_OPTIONS = Object.entries(COMBO_PRESETS).map(([key, subKeys]) => {
  const labels = subKeys.map((k) => ETF_PRESETS[k].name);
  return { value: key, label: labels.join(" + ") };
});

export const CARD_PRESET_SELECT_OPTIONS = SINGLE_PRESET_OPTIONS;
export const PRESET_SELECT_OPTIONS = [
  ...COMBO_PRESET_OPTIONS,
  ...SINGLE_PRESET_OPTIONS.filter((option) => ETF_PRESETS[option.value]?.simulated),
];

/** Get the default start date for a preset, respecting per-preset overrides. */
function getPresetDefaultStartDate(preset: EtfPreset): string {
  if (preset.launchDate) return preset.launchDate;
  if (preset.defaultStartDate) return preset.defaultStartDate;
  return INDEX_DATE_RANGES[preset.index].min;
}

export function getConfigDefaultStartDate(config: Pick<EtfConfig, "name" | "simulated" | "smaIndex">): string {
  const preset = Object.values(ETF_PRESETS).find(
    (candidate) => candidate.name === config.name && candidate.simulated === config.simulated
  );
  if (!preset) return INDEX_DATE_RANGES[config.smaIndex].min;
  return getPresetDefaultStartDate(preset);
}

export function createDefaultEtfConfig(id: string): EtfConfig {
  return {
    id,
    name: "UPRO",
    leverage: 3,
    expenseRatio: 0.91,
    simulated: true,
    smaEnabled: true,
    smaPeriod: getDefaultSmaPeriod("sp500"),
    smaBuffer: getDefaultSmaBuffer("sp500"),
    smaIndex: "sp500",
    riskOffAsset: DEFAULT_RISK_OFF_ASSET,
  };
}

export function createPresetEtfConfig(
  id: string,
  preset: EtfPreset,
  overrides: Partial<EtfConfig>,
): EtfConfig {
  return {
    id,
    name: preset.name,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: preset.simulated,
    smaEnabled: true,
    smaPeriod: getDefaultSmaPeriod(preset.index),
    smaBuffer: getDefaultSmaBuffer(preset.index),
    smaIndex: preset.index,
    riskOffAsset: DEFAULT_RISK_OFF_ASSET,
    ...overrides,
  };
}

export function applyPreset(config: EtfConfig, presetKey: string): EtfConfig {
  const preset = ETF_PRESETS[presetKey];
  if (!preset) return config;
  return {
    ...config,
    name: preset.name,
    leverage: preset.leverage,
    expenseRatio: preset.expenseRatio,
    simulated: preset.simulated,
    smaIndex: preset.index,
  };
}

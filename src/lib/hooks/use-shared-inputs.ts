/**
 * Shared input state persisted to localStorage across all tool pages.
 *
 * When a user changes a field (e.g. spxRiskOffAsset) on any page,
 * it persists and is picked up by all other pages on next visit.
 *
 * URL params take priority over stored values (so shared links work).
 * Page-specific fields (e.g. minSmaPeriod) are NOT included here.
 */

import {
  getDefaultSmaPeriod,
  getDefaultSmaUpperBuffer,
  getDefaultSmaLowerBuffer,
  getDefaultWindowLength,
  DEFAULT_SMA_VOL_GATE,
} from "@/lib/simulation/defaults";
import { DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { getIsoDate } from "@/lib/date";
import type { EtfConfig } from "@/lib/simulation/types";
import { CONSTANT_SP500_SHORTCUT_DATE } from "../constants";
import { DEFAULT_RISK_OFF_ASSETS } from "../simulation/defaults";
import { parseRiskOffUrlParams } from "@/lib/risk-off-url-params";
import {
  DEFAULT_START_SELECTION,
  PER_INDEX_EARLIEST_START_DATE,
  readPerIndexStartUrlParam,
} from "@/lib/per-index-start";
import { hasMeaningfulSearchParams } from "@/lib/tools-route";
import { parseSmaBufferUrlParams } from "@/lib/sma-buffer-url-params";
import {
  normalizeBooleanValue,
  normalizeDateString,
  normalizeObjectByDefaults,
  normalizeNumberValue,
  normalizePresetKey,
  normalizeRiskOffAsset,
} from "@/lib/input-normalization";

const STORAGE_KEY = "shared-inputs";

type SharedInputs = {
  letf: string;
  startDate: string;
  /** "SPX/NDX start": each index from its own real series (see per-index-start.ts). */
  perIndexStart: boolean;
  endDate: string;
  windowLength: number;
  smaSpPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaSpEnabled: boolean;
  smaNqPeriod: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  smaNqEnabled: boolean;
  smaVolGate: boolean;
  spxRiskOffAsset: EtfConfig["riskOffAsset"];
  ndxRiskOffAsset: EtfConfig["riskOffAsset"];
  hateDrawdown: boolean;
  tradeAfterHours: boolean;
};

export const SHARED_KEYS = new Set<string>([
  "letf",
  "startDate",
  "perIndexStart",
  "endDate",
  "windowLength",
  "smaSpPeriod",
  "smaNqPeriod",
  "smaSpUpperBuffer",
  "smaSpLowerBuffer",
  "smaNqUpperBuffer",
  "smaNqLowerBuffer",
  "smaSpEnabled",
  "smaNqEnabled",
  "smaVolGate",
  "spxRiskOffAsset",
  "ndxRiskOffAsset",
  "hateDrawdown",
  "tradeAfterHours",
]);


const DEFAULTS: SharedInputs = {
  letf: DEFAULT_COMBO_PRESET,
  startDate: DEFAULT_START_SELECTION.startDate,
  perIndexStart: DEFAULT_START_SELECTION.perIndexStart,
  endDate: getIsoDate(new Date()),
  windowLength: getDefaultWindowLength(),
  smaSpPeriod: getDefaultSmaPeriod("sp500"),
  smaNqPeriod: getDefaultSmaPeriod("nasdaq100"),
  smaSpUpperBuffer: getDefaultSmaUpperBuffer("sp500"),
  smaSpLowerBuffer: getDefaultSmaLowerBuffer("sp500"),
  smaNqUpperBuffer: getDefaultSmaUpperBuffer("nasdaq100"),
  smaNqLowerBuffer: getDefaultSmaLowerBuffer("nasdaq100"),
  smaSpEnabled: true,
  smaNqEnabled: true,
  smaVolGate: DEFAULT_SMA_VOL_GATE,
  spxRiskOffAsset: DEFAULT_RISK_OFF_ASSETS.sp500,
  ndxRiskOffAsset: DEFAULT_RISK_OFF_ASSETS.nasdaq100,
  hateDrawdown: false,
  tradeAfterHours: false,
};

function normalizeSharedInputs(inputs: Partial<SharedInputs>): SharedInputs {
  const today = getIsoDate(new Date());
  const base = normalizeObjectByDefaults({ ...DEFAULTS, ...inputs }, DEFAULTS, {
    windowLength: { integer: true, min: 1 },
    smaSpPeriod: { integer: true, min: 1 },
    smaNqPeriod: { integer: true, min: 1 },
    smaSpUpperBuffer: { min: 0 },
    smaSpLowerBuffer: { min: 0 },
    smaNqUpperBuffer: { min: 0 },
    smaNqLowerBuffer: { min: 0 },
  });
  const perIndexStart = normalizeBooleanValue(base.perIndexStart, false);

  return {
    letf: normalizePresetKey(base.letf, DEFAULT_COMBO_PRESET),
    startDate: perIndexStart
      ? PER_INDEX_EARLIEST_START_DATE
      : normalizeDateString(base.startDate, CONSTANT_SP500_SHORTCUT_DATE),
    perIndexStart,
    endDate: normalizeDateString(base.endDate, today),
    windowLength: normalizeNumberValue(base.windowLength, getDefaultWindowLength(), { integer: true, min: 1 }),
    smaSpPeriod: normalizeNumberValue(base.smaSpPeriod, getDefaultSmaPeriod("sp500"), { integer: true, min: 1 }),
    smaNqPeriod: normalizeNumberValue(base.smaNqPeriod, getDefaultSmaPeriod("nasdaq100"), { integer: true, min: 1 }),
    smaSpUpperBuffer: normalizeNumberValue(base.smaSpUpperBuffer, getDefaultSmaUpperBuffer("sp500"), { min: 0 }),
    smaSpLowerBuffer: normalizeNumberValue(base.smaSpLowerBuffer, getDefaultSmaLowerBuffer("sp500"), { min: 0 }),
    smaNqUpperBuffer: normalizeNumberValue(base.smaNqUpperBuffer, getDefaultSmaUpperBuffer("nasdaq100"), { min: 0 }),
    smaNqLowerBuffer: normalizeNumberValue(base.smaNqLowerBuffer, getDefaultSmaLowerBuffer("nasdaq100"), { min: 0 }),
    smaSpEnabled: normalizeBooleanValue(base.smaSpEnabled, true),
    smaNqEnabled: normalizeBooleanValue(base.smaNqEnabled, true),
    smaVolGate: normalizeBooleanValue(base.smaVolGate, DEFAULT_SMA_VOL_GATE),
    spxRiskOffAsset: normalizeRiskOffAsset(base.spxRiskOffAsset, DEFAULT_RISK_OFF_ASSETS.sp500),
    ndxRiskOffAsset: normalizeRiskOffAsset(base.ndxRiskOffAsset, DEFAULT_RISK_OFF_ASSETS.nasdaq100),
    hateDrawdown: normalizeBooleanValue(base.hateDrawdown, false),
    tradeAfterHours: normalizeBooleanValue(base.tradeAfterHours, false),
  };
}

function loadStored(): Partial<SharedInputs> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<SharedInputs>;
  } catch {
    return {};
  }
}

/** The end date the user deliberately picked, or null when it follows today. */
export function getStoredEndDate(): string | null {
  const stored = loadStored().endDate;
  return typeof stored === "string" && stored !== getIsoDate(new Date()) ? stored : null;
}

function saveStored(inputs: SharedInputs): void {
  if (typeof window === "undefined") return;
  try {
    // An end date of today is the rolling default, not a choice: storing it would
    // pin tomorrow's visit to a stale end. Only a deliberately picked date sticks.
    const { endDate, ...rest } = inputs;
    const persisted = endDate === getIsoDate(new Date()) ? rest : inputs;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // ignore quota errors
  }
}

/**
 * Returns initial values for shared input fields, merging:
 * 1. Hardcoded defaults
 * 2. localStorage (overrides defaults)
 * 3. URL params (overrides localStorage) — only if `urlParams` provided
 *
 * Also returns a `persist` function to save current values back to localStorage.
 */

let pendingUpdates: Partial<SharedInputs> = {};

export function getSharedInputs(urlParams?: URLSearchParams): {
  inputs: SharedInputs;
  persist: (updates: Partial<SharedInputs>) => void;
} {
  const stored = loadStored();
  const merged = normalizeSharedInputs({ ...DEFAULTS, ...stored, ...pendingUpdates });

  // Auto-read URL params from window.location if not provided
  const effectiveUrlParams = urlParams ??
    (typeof window !== "undefined" && hasMeaningfulSearchParams(window.location.search)
      ? new URLSearchParams(window.location.search)
      : null);

  // URL params override stored values
  if (effectiveUrlParams) {
    const p = effectiveUrlParams;
    if (p.has("letf")) merged.letf = p.get("letf")!;
    if (p.has("sd")) merged.startDate = p.get("sd")!;
    const urlPerIndexStart = readPerIndexStartUrlParam(p);
    if (urlPerIndexStart !== undefined) merged.perIndexStart = urlPerIndexStart;
    if (p.has("ed")) merged.endDate = p.get("ed")!;
    if (p.has("py")) {
      merged.windowLength = Number(p.get("py")) || merged.windowLength;
    }
    if (p.has("smaPsp")) {
      merged.smaSpPeriod = Number(p.get("smaPsp")) || merged.smaSpPeriod;
    }
    if (p.has("smaPnq")) {
      merged.smaNqPeriod = Number(p.get("smaPnq")) || merged.smaNqPeriod;
    }
    const smaBuffers = parseSmaBufferUrlParams(p);
    if (smaBuffers.smaSpUpperBuffer != null) merged.smaSpUpperBuffer = smaBuffers.smaSpUpperBuffer;
    if (smaBuffers.smaSpLowerBuffer != null) merged.smaSpLowerBuffer = smaBuffers.smaSpLowerBuffer;
    if (smaBuffers.smaNqUpperBuffer != null) merged.smaNqUpperBuffer = smaBuffers.smaNqUpperBuffer;
    if (smaBuffers.smaNqLowerBuffer != null) merged.smaNqLowerBuffer = smaBuffers.smaNqLowerBuffer;
    if (smaBuffers.smaVolGate != null) merged.smaVolGate = smaBuffers.smaVolGate;
    const riskOffAssets = parseRiskOffUrlParams(p);
    if (riskOffAssets.sp500) merged.spxRiskOffAsset = riskOffAssets.sp500;
    if (riskOffAssets.nasdaq100) merged.ndxRiskOffAsset = riskOffAssets.nasdaq100;
  }

  return {
    inputs: normalizeSharedInputs(merged),
    persist: (updates: Partial<SharedInputs>) => {
      pendingUpdates = { ...pendingUpdates, ...updates };
      const current = normalizeSharedInputs({ ...DEFAULTS, ...loadStored(), ...pendingUpdates });
      saveStored(current);
    },
  };
}

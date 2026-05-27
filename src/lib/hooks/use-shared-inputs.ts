/**
 * Shared input state persisted to localStorage across all tool pages.
 *
 * When a user changes a field (e.g. riskOffAsset) on any page,
 * it persists and is picked up by all other pages on next visit.
 *
 * URL params take priority over stored values (so shared links work).
 * Page-specific fields (e.g. minSmaPeriod) are NOT included here.
 */

import {
  getDefaultSmaPeriod,
  getDefaultSmaBuffer,
  getDefaultWindowLength,
} from "@/lib/simulation/defaults";
import { DEFAULT_COMBO_PRESET } from "@/lib/simulation/presets";
import { getIsoDate } from "@/lib/date";
import type { EtfConfig } from "@/lib/simulation/types";
import { CONSTANT_SP500_SHORTCUT_DATE } from "../constants";
import { DEFAULT_RISK_OFF_ASSET } from "../simulation/defaults";
import { hasMeaningfulSearchParams } from "@/lib/tools-route";
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
  riskOffAsset: EtfConfig["riskOffAsset"];
  hateDrawdown: boolean;
  tradeAfterHours: boolean;
};

export const SHARED_KEYS = new Set<string>([
  "letf",
  "startDate",
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
  "riskOffAsset",
  "hateDrawdown",
  "tradeAfterHours",
]);


const DEFAULTS: SharedInputs = {
  letf: DEFAULT_COMBO_PRESET,
  startDate: CONSTANT_SP500_SHORTCUT_DATE,
  endDate: getIsoDate(new Date()),
  windowLength: getDefaultWindowLength(),
  smaSpPeriod: getDefaultSmaPeriod("sp500"),
  smaNqPeriod: getDefaultSmaPeriod("nasdaq100"),
  smaSpUpperBuffer: getDefaultSmaBuffer("sp500"),
  smaSpLowerBuffer: getDefaultSmaBuffer("sp500"),
  smaNqUpperBuffer: getDefaultSmaBuffer("nasdaq100"),
  smaNqLowerBuffer: getDefaultSmaBuffer("nasdaq100"),
  smaSpEnabled: true,
  smaNqEnabled: true,
  riskOffAsset: DEFAULT_RISK_OFF_ASSET,
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

  return {
    letf: normalizePresetKey(base.letf, DEFAULT_COMBO_PRESET),
    startDate: normalizeDateString(base.startDate, CONSTANT_SP500_SHORTCUT_DATE),
    endDate: normalizeDateString(base.endDate, today),
    windowLength: normalizeNumberValue(base.windowLength, getDefaultWindowLength(), { integer: true, min: 1 }),
    smaSpPeriod: normalizeNumberValue(base.smaSpPeriod, getDefaultSmaPeriod("sp500"), { integer: true, min: 1 }),
    smaNqPeriod: normalizeNumberValue(base.smaNqPeriod, getDefaultSmaPeriod("nasdaq100"), { integer: true, min: 1 }),
    smaSpUpperBuffer: normalizeNumberValue(base.smaSpUpperBuffer, getDefaultSmaBuffer("sp500"), { min: 0 }),
    smaSpLowerBuffer: normalizeNumberValue(base.smaSpLowerBuffer, getDefaultSmaBuffer("sp500"), { min: 0 }),
    smaNqUpperBuffer: normalizeNumberValue(base.smaNqUpperBuffer, getDefaultSmaBuffer("nasdaq100"), { min: 0 }),
    smaNqLowerBuffer: normalizeNumberValue(base.smaNqLowerBuffer, getDefaultSmaBuffer("nasdaq100"), { min: 0 }),
    smaSpEnabled: normalizeBooleanValue(base.smaSpEnabled, true),
    smaNqEnabled: normalizeBooleanValue(base.smaNqEnabled, true),
    riskOffAsset: normalizeRiskOffAsset(base.riskOffAsset),
    hateDrawdown: normalizeBooleanValue(base.hateDrawdown, false),
    tradeAfterHours: normalizeBooleanValue(base.tradeAfterHours, false),
  };
}

function loadStored(): Partial<SharedInputs> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SharedInputs>;
    delete parsed.endDate;
    return parsed;
  } catch {
    return {};
  }
}

function saveStored(inputs: SharedInputs): void {
  if (typeof window === "undefined") return;
  try {
    const { endDate, ...persisted } = inputs;
    void endDate;
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
    if (p.has("smatspU")) {
      merged.smaSpUpperBuffer = Number(p.get("smatspU")) || merged.smaSpUpperBuffer;
    }
    if (p.has("smatspL")) {
      merged.smaSpLowerBuffer = Number(p.get("smatspL")) || merged.smaSpLowerBuffer;
    }
    if (p.has("smatnqU")) {
      merged.smaNqUpperBuffer = Number(p.get("smatnqU")) || merged.smaNqUpperBuffer;
    }
    if (p.has("smatnqL")) {
      merged.smaNqLowerBuffer = Number(p.get("smatnqL")) || merged.smaNqLowerBuffer;
    }
    if (p.has("ro")) {
      merged.riskOffAsset = normalizeRiskOffAsset(p.get("ro"), merged.riskOffAsset);
    }
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

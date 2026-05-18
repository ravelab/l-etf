import { RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import { DEFAULT_RISK_OFF_ASSET } from "@/lib/simulation/defaults";
import { DEFAULT_COMBO_PRESET, getValidPresetKey } from "@/lib/simulation/presets";
import type { IndexKey, RiskOffAsset } from "@/lib/simulation/types";

export const DEFAULT_SMA_EXECUTION_MODE = "next-day-open" as const;

const VALID_RISK_OFF_ASSETS = new Set(
  RISK_OFF_ASSET_OPTIONS.map((opt) => opt.value)
);

export function normalizePresetKey(value: unknown, fallback = DEFAULT_COMBO_PRESET): string {
  return typeof value === "string" ? getValidPresetKey(value, fallback) : fallback;
}

export function normalizeIndexKey(value: unknown, fallback: IndexKey = "sp500"): IndexKey {
  return value === "sp500" || value === "nasdaq100" ? value : fallback;
}

export function normalizeRiskOffAsset(
  value: unknown,
  fallback: RiskOffAsset = DEFAULT_RISK_OFF_ASSET
): RiskOffAsset {
  return typeof value === "string" && VALID_RISK_OFF_ASSETS.has(value as RiskOffAsset)
    ? (value as RiskOffAsset)
    : fallback;
}

export function normalizeDateString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed) return fallback;

  const normalized = trimmed.replaceAll("/", "-");
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;

  const [, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return fallback;
  if (date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return fallback;
  return `${y}-${m}-${d}`;
}

export function normalizeNumberValue(
  value: unknown,
  fallback: number,
  options?: { integer?: boolean; min?: number; max?: number }
): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  if (options?.integer && !Number.isInteger(parsed)) return fallback;
  if (options?.min != null && parsed < options.min) return fallback;
  if (options?.max != null && parsed > options.max) return fallback;
  return parsed;
}

export function normalizeBooleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

export function normalizeSelectValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T
): T {
  return typeof value === "string" && allowedValues.includes(value as T)
    ? (value as T)
    : fallback;
}

type NormalizeNumberRule = { integer?: boolean; min?: number; max?: number };

export function normalizeObjectByDefaults<T extends Record<string, unknown>>(
  value: Record<string, unknown>,
  defaults: T,
  numberRules: Record<string, NormalizeNumberRule> = {},
): T {
  const sanitized = { ...defaults } as T;

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const nextValue = value[key];
    if (nextValue === undefined || nextValue === null) continue;

    if (typeof defaultValue === "number") {
      const rule = numberRules[key];
      (sanitized as Record<string, unknown>)[key] = normalizeNumberValue(nextValue, defaultValue, rule);
      continue;
    }

    if (typeof defaultValue === "boolean") {
      (sanitized as Record<string, unknown>)[key] = normalizeBooleanValue(nextValue, defaultValue);
      continue;
    }

    if (typeof defaultValue === "string") {
      (sanitized as Record<string, unknown>)[key] = typeof nextValue === "string" ? nextValue : defaultValue;
      continue;
    }

    if (defaultValue === null) {
      (sanitized as Record<string, unknown>)[key] = nextValue;
      continue;
    }

    if (Array.isArray(defaultValue)) {
      (sanitized as Record<string, unknown>)[key] = Array.isArray(nextValue) ? nextValue : defaultValue;
      continue;
    }

    if (defaultValue && typeof defaultValue === "object") {
      (sanitized as Record<string, unknown>)[key] = nextValue && typeof nextValue === "object" && !Array.isArray(nextValue)
        ? nextValue
        : defaultValue;
    }
  }

  return sanitized;
}

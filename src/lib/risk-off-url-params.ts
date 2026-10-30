import { RISK_OFF_ASSET_OPTIONS } from "@/lib/constants";
import type { IndexKey, RiskOffAsset } from "@/lib/simulation/types";

/** What each index's strategies hold while risk-off. */
export type RiskOffAssetsByIndex = Record<IndexKey, RiskOffAsset>;

/** Canonical URL keys for the per-index risk-off assets (shared across tool tabs). */
export const RISK_OFF_URL_KEYS = { sp500: "ros", nasdaq100: "ron" } as const satisfies Record<IndexKey, string>;

/**
 * The single risk-off asset that links carried before it was split per index. Still read
 * so old history links, MCP permalinks and bookmarks keep their asset, applied to both
 * indices; a per-index key in the same link wins.
 */
const LEGACY_RISK_OFF_URL_KEY = "ro";

const INDEX_KEYS = Object.keys(RISK_OFF_URL_KEYS) as IndexKey[];

/** Write both per-index risk-off keys, dropping the legacy single key. */
export function appendRiskOffUrlParams(params: URLSearchParams, assets: RiskOffAssetsByIndex): void {
  params.delete(LEGACY_RISK_OFF_URL_KEY);
  for (const index of INDEX_KEYS) params.set(RISK_OFF_URL_KEYS[index], assets[index]);
}

/** Remove every risk-off key, for a page whose own subject is the risk-off asset. */
export function deleteRiskOffUrlParams(params: URLSearchParams): void {
  params.delete(LEGACY_RISK_OFF_URL_KEY);
  for (const index of INDEX_KEYS) params.delete(RISK_OFF_URL_KEYS[index]);
}

/** The per-index risk-off assets a link names, ignoring values that are not valid assets. */
export function parseRiskOffUrlParams(params: URLSearchParams): Partial<RiskOffAssetsByIndex> {
  const out: Partial<RiskOffAssetsByIndex> = {};
  const legacy = validAsset(params.get(LEGACY_RISK_OFF_URL_KEY));
  for (const index of INDEX_KEYS) {
    const asset = validAsset(params.get(RISK_OFF_URL_KEYS[index])) ?? legacy;
    if (asset) out[index] = asset;
  }
  return out;
}

/** True unless the link names a risk-off asset that differs from the state's. */
export function riskOffUrlParamsMatchState(
  params: URLSearchParams,
  state: { spxRiskOffAsset?: unknown; ndxRiskOffAsset?: unknown },
): boolean {
  const fromUrl = parseRiskOffUrlParams(params);
  if (fromUrl.sp500 != null && state.spxRiskOffAsset !== fromUrl.sp500) return false;
  if (fromUrl.nasdaq100 != null && state.ndxRiskOffAsset !== fromUrl.nasdaq100) return false;
  return true;
}

const VALID_RISK_OFF_ASSETS = new Set<string>(RISK_OFF_ASSET_OPTIONS.map((option) => option.value));

function validAsset(raw: string | null): RiskOffAsset | undefined {
  return raw != null && VALID_RISK_OFF_ASSETS.has(raw) ? (raw as RiskOffAsset) : undefined;
}

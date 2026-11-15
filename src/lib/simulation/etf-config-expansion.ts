import type { EtfConfig, EtfResult } from "./types";
import { getSignalRule } from "./signal-rules";

function formatRiskOffAsset(asset: EtfConfig["riskOffAsset"]): string {
  return asset.replace(/BRK\.A/g, "BRK.B").replace(/\+/g, " + ");
}

/**
 * If SMA is enabled, expand each config into its baseline (no SMA) and SMA variants
 * for side-by-side comparison in charts and tables.
 */
export function expandEtfConfigs(etfConfigs: EtfConfig[]): EtfConfig[] {
  return etfConfigs.flatMap((config) => {
    if (!config.smaEnabled) return [config];
    const baselineConfig: EtfConfig = {
      ...config,
      id: `${config.id}-base`,
      name: `${config.name} (No SMA)`,
      smaEnabled: false,
    };
    const ruleLabel = config.signalRule
      ? getSignalRule(config.signalRule).label
      : `SMA${config.smaVolGate ? " Vol RSI" : ""}`;
    const smaConfig: EtfConfig = {
      ...config,
      id: `${config.id}-sma`,
      name: `${config.name} (${ruleLabel}, ${formatRiskOffAsset(config.riskOffAsset)})`,
    };
    return [baselineConfig, smaConfig];
  });
}

/** How many results {@link expandEtfConfigs} turns `configs` into, before dedupe. */
export function expandedConfigCount(configs: EtfConfig[]): number {
  return configs.reduce((count, config) => count + (config.smaEnabled ? 2 : 1), 0);
}

/**
 * The requested config a (possibly expanded) result id came from: the config
 * itself, or the one whose `-base` / `-sma` variant it is.
 */
export function findOwningConfig(configs: EtfConfig[], resultId: string): EtfConfig | undefined {
  return configs.find((config) => config.id === resultId || resultId.startsWith(`${config.id}-`));
}

function stripStrategySuffix(name: string): string {
  return name
    .replace(/ \(No SMA\)$/, "")
    .replace(/ \(SMA Trigger-Day Close[^)]*\)$/, "")
    .replace(/ \(SMA Next-Day Open[^)]*\)$/, "")
    .replace(/ \(SMA Next-Day Close[^)]*\)$/, "")
    .replace(/ \(SMA[^)]*\)$/, "");
}

/** Base ticker an expanded config's real-ETF prices are keyed by: strategy suffix and `-real` stripped. */
export function getHistoricalPriceSymbol(name: string): string {
  return stripStrategySuffix(name).replace(/-real$/, "");
}

function buildDedupeKey(config: EtfConfig): string {
  const base = {
    symbol: getHistoricalPriceSymbol(config.name),
    leverage: config.leverage,
    expenseRatio: config.expenseRatio,
    simulated: config.simulated,
    smaIndex: config.smaIndex,
    smaEnabled: config.smaEnabled,
  };

  if (!config.smaEnabled) {
    return JSON.stringify(base);
  }

  return JSON.stringify({
    ...base,
    smaPeriod: config.smaPeriod,
    smaUpperBuffer: config.smaUpperBuffer,
    smaLowerBuffer: config.smaLowerBuffer,
    smaVolGate: config.smaVolGate === true,
    signalRule: config.signalRule ?? null,
    riskOffAsset: config.riskOffAsset,
    smaExecutionMode: config.smaExecutionMode,
  });
}

/**
 * Collapse configs that are computationally identical to one simulation each,
 * and record which requested ids each surviving config stands in for.
 *
 * The fingerprint deliberately excludes `id`: N SMA configs on one LETF expand
 * to N identical no-SMA `-base` variants that only need simulating (and
 * drawing) once. But the dropped ids were previously unrecoverable, so
 * `etfResults.find(r => r.id === 'B-base')` — the selection pattern this
 * codebase mandates — silently returned undefined. The aliases let callers
 * resolve those ids without emitting duplicate series.
 */
export function dedupeExpandedConfigs(configs: EtfConfig[]): {
  unique: EtfConfig[];
  aliases: Record<string, string>;
} {
  const canonicalByKey = new Map<string, EtfConfig>();
  const unique: EtfConfig[] = [];
  const aliases: Record<string, string> = {};

  for (const config of configs) {
    const key = buildDedupeKey(config);
    const canonical = canonicalByKey.get(key);
    if (canonical) {
      if (canonical.id !== config.id) aliases[config.id] = canonical.id;
      continue;
    }
    canonicalByKey.set(key, config);
    unique.push(config);
  }

  return { unique, aliases };
}

function parseVariant(id: string): { baseId: string; rank: number } {
  if (id.endsWith("-base")) return { baseId: id.slice(0, -5), rank: 0 };
  if (id.endsWith("-sma")) return { baseId: id.slice(0, -4), rank: 1 };
  if (id.endsWith("-smaOpen")) return { baseId: id.slice(0, -8), rank: 2 };
  if (id.endsWith("-smaClose")) return { baseId: id.slice(0, -9), rank: 3 };
  return { baseId: id, rank: 0 };
}

/** Display order: by base config id, then no-SMA before its SMA variants. */
export function compareEtfResultOrder(a: EtfResult, b: EtfResult): number {
  const aInfo = parseVariant(a.id);
  const bInfo = parseVariant(b.id);
  if (aInfo.baseId !== bInfo.baseId) return aInfo.baseId.localeCompare(bInfo.baseId);
  return aInfo.rank - bInfo.rank;
}

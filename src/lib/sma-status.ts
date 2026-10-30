import storage, { type DailyPrice } from "@/lib/data/storage";
import { getDefaultSmaLowerBuffer, getDefaultSmaPeriod, getDefaultSmaUpperBuffer } from "@/lib/simulation/defaults";
import { getSmaSignal, type SmaSignalResult } from "@/lib/sma-signals";
import { SMA_VOL_GATE, volGateParamsTextFor } from "@/lib/simulation/vol-gate";
import type { IndexKey } from "@/lib/simulation/types";

export type SmaSignalConfig = {
  smaSpPeriod: number;
  smaSpUpperBuffer: number;
  smaSpLowerBuffer: number;
  smaSpEnabled: boolean;
  smaNqPeriod: number;
  smaNqUpperBuffer: number;
  smaNqLowerBuffer: number;
  smaNqEnabled: boolean;
  /** Volatility risk-off gate (see vol-gate.ts) on top of both SMAs. Absent on older stored subscriptions. */
  smaVolGate?: boolean;
  /** If true, deliver a push every market close regardless of whether the SMA signal changed. */
  notifyEveryClose: boolean;
  /** If true, the period/buffer fields above are kept in sync with the latest SMA calibration snapshot. */
  useCalibratedDefaults: boolean;
};

export type SmaSignalSnapshot = {
  sp500: SmaSignalResult;
  nasdaq100: SmaSignalResult;
  timestamp: string;
};

const DEFAULT_SMA_SIGNAL_CONFIG: SmaSignalConfig = {
  smaSpPeriod: getDefaultSmaPeriod("sp500"),
  smaSpUpperBuffer: getDefaultSmaUpperBuffer("sp500"),
  smaSpLowerBuffer: getDefaultSmaLowerBuffer("sp500"),
  smaSpEnabled: true,
  smaNqPeriod: getDefaultSmaPeriod("nasdaq100"),
  smaNqUpperBuffer: getDefaultSmaUpperBuffer("nasdaq100"),
  smaNqLowerBuffer: getDefaultSmaLowerBuffer("nasdaq100"),
  smaNqEnabled: true,
  smaVolGate: true,
  notifyEveryClose: false,
  useCalibratedDefaults: false,
};

const DEFAULT_LOOKBACK_YEARS = 2;

export function getDefaultSmaSignalConfig(): SmaSignalConfig {
  return { ...DEFAULT_SMA_SIGNAL_CONFIG };
}

// useCalibratedDefaults is deliberately excluded: it describes where the period/buffer
// values came from, not a signal-affecting parameter, so toggling it alone shouldn't
// register as a config change.
export function buildSmaSignalConfigFingerprint(config: SmaSignalConfig): string {
  return [
    config.smaSpPeriod,
    config.smaSpUpperBuffer,
    config.smaSpLowerBuffer,
    config.smaSpEnabled ? "1" : "0",
    config.smaNqPeriod,
    config.smaNqUpperBuffer,
    config.smaNqLowerBuffer,
    config.smaNqEnabled ? "1" : "0",
    config.notifyEveryClose ? "1" : "0",
    // Appended only when on so every existing subscription keeps its fingerprint.
    ...(config.smaVolGate ? ["vg"] : []),
  ].join("|");
}

function formatCompactPercent(value: number): string {
  const rounded = value.toFixed(1);
  return rounded.endsWith(".0") ? `${rounded.slice(0, -2)}%` : `${rounded}%`;
}

function formatSignedPercent(value: number): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

type SmaRegime = "risk-on" | "risk-off";

function getSmaRegime(result: SmaSignalResult): SmaRegime {
  if (result.signal === "sell" || result.signalLabel === "Sell L-ETFs") {
    return "risk-off";
  }
  return "risk-on";
}

function getSmaRegimeLabel(result: SmaSignalResult): string {
  if (result.signalLabel === "Buy") return "Buy L-ETFs";
  if (result.signalLabel === "Sell") return "Sell L-ETFs";
  return result.signalLabel;
}

function formatSmaStatus(result: SmaSignalResult): string {
  const vol = result.volatility != null && Number.isFinite(result.volatility)
    ? `, vol ${Math.round(result.volatility * 100)}%` : "";
  return `${getSmaRegimeLabel(result)} (${formatSignedPercent(result.percentDiff)}${vol})`;
}

export function buildSmaSignalFingerprint(snapshot: SmaSignalSnapshot, config?: SmaSignalConfig): string {
  const parts = [
    config?.smaSpEnabled !== false ? getSmaRegime(snapshot.sp500) : "disabled",
    config?.smaNqEnabled !== false ? getSmaRegime(snapshot.nasdaq100) : "disabled"
  ];
  return parts.join("|");
}

export function describeSmaSignalStatus(snapshot: SmaSignalSnapshot, config?: SmaSignalConfig): string {
  const parts = [];
  if (config?.smaSpEnabled !== false) {
    parts.push(`SPX: ${formatSmaStatus(snapshot.sp500)}`);
  }
  if (config?.smaNqEnabled !== false) {
    parts.push(`NDX: ${formatSmaStatus(snapshot.nasdaq100)}`);
  }
  if (parts.length === 0) return "No alerts enabled";
  return config?.smaVolGate ? `${parts.join("; ")} · ${volGateLabelFor(config)}` : parts.join("; ");
}

/** The gate label for the indices this config alerts on, each with its own parameters. */
function volGateLabelFor(config: Pick<SmaSignalConfig, "smaSpEnabled" | "smaNqEnabled">): string {
  const enabled: IndexKey[] = [
    ...(config.smaSpEnabled !== false ? (["sp500"] as const) : []),
    ...(config.smaNqEnabled !== false ? (["nasdaq100"] as const) : []),
  ];
  return `vol ${volGateParamsTextFor(enabled)}`;
}

export function describeSmaSignalConfig(config: SmaSignalConfig): string {
  const parts = [];
  if (config.smaSpEnabled) {
    parts.push(`SPX ${config.smaSpPeriod} SMA, −${formatCompactPercent(config.smaSpLowerBuffer)}/${formatCompactPercent(config.smaSpUpperBuffer)}`);
  }
  if (config.smaNqEnabled) {
    parts.push(`NDX ${config.smaNqPeriod} SMA, −${formatCompactPercent(config.smaNqLowerBuffer)}/${formatCompactPercent(config.smaNqUpperBuffer)}`);
  }
  if (parts.length > 0 && config.smaVolGate) parts.push(volGateLabelFor(config));
  return parts.length > 0 ? parts.join("; ") : "None";
}

export function describeSmaSignalChange(
  current: SmaSignalSnapshot,
  previous?: SmaSignalSnapshot | null,
  config?: SmaSignalConfig
): string {
  if (!previous) return describeSmaSignalStatus(current, config);

  const changes: string[] = [];
  if (config?.smaSpEnabled !== false && buildIndexChange(current.sp500, previous.sp500)) {
    changes.push(`SPX switched to ${formatSmaStatus(current.sp500)}`);
  }
  if (config?.smaNqEnabled !== false && buildIndexChange(current.nasdaq100, previous.nasdaq100)) {
    changes.push(`NDX switched to ${formatSmaStatus(current.nasdaq100)}`);
  }

  if (changes.length === 0) return describeSmaSignalStatus(current, config);
  return `${changes.join("; ")}. Current: ${describeSmaSignalStatus(current, config)}`;
}

export async function fetchSmaMarketData(): Promise<{ sp500Prices: DailyPrice[]; nasdaqPrices: DailyPrice[] }> {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - DEFAULT_LOOKBACK_YEARS * 365.25 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [sp500Prices, nasdaqPrices] = await Promise.all([
    storage.getPrices("sp500", startDate, endDate),
    storage.getPrices("nasdaq100", startDate, endDate),
  ]);

  if (sp500Prices.length === 0) {
    throw new Error(`SPX price data unavailable for ${startDate} to ${endDate}.`);
  }
  if (nasdaqPrices.length === 0) {
    throw new Error(`NDX price data unavailable for ${startDate} to ${endDate}.`);
  }

  return { sp500Prices, nasdaqPrices };
}

export async function getCurrentSmaSignalSnapshot(
  config: SmaSignalConfig = DEFAULT_SMA_SIGNAL_CONFIG,
  preFetchedData?: { sp500Prices: DailyPrice[]; nasdaqPrices: DailyPrice[] }
): Promise<SmaSignalSnapshot> {
  const data = preFetchedData ?? (await fetchSmaMarketData());

  return computeSmaSignalSnapshot({
    sp500Prices: data.sp500Prices,
    nasdaqPrices: data.nasdaqPrices,
    config,
  });
}

export function computeSmaSignalSnapshot(params: {
  sp500Prices: DailyPrice[];
  nasdaqPrices: DailyPrice[];
  config: SmaSignalConfig;
  timestamp?: string;
}): SmaSignalSnapshot {
  const { sp500Prices, nasdaqPrices, config, timestamp = new Date().toISOString() } = params;
  const options = (index: IndexKey) => (config.smaVolGate === true ? { volGate: SMA_VOL_GATE[index] } : {});

  return {
    sp500: getSmaSignal(sp500Prices, config.smaSpPeriod, { upper: config.smaSpUpperBuffer, lower: config.smaSpLowerBuffer }, options("sp500")),
    nasdaq100: getSmaSignal(nasdaqPrices, config.smaNqPeriod, { upper: config.smaNqUpperBuffer, lower: config.smaNqLowerBuffer }, options("nasdaq100")),
    timestamp,
  };
}

function buildIndexChange(current: SmaSignalResult, previous: SmaSignalResult): boolean {
  return getSmaRegime(current) !== getSmaRegime(previous);
}

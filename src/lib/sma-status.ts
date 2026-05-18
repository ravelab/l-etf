import storage, { type DailyPrice } from "@/lib/data/storage";
import { getDefaultSmaBuffer, getDefaultSmaPeriod } from "@/lib/simulation/defaults";
import { getSmaSignal, type SmaSignalResult } from "@/lib/sma-signals";

export type SmaSignalConfig = {
  smaSpPeriod: number;
  smaSpBuffer: number;
  smaSpEnabled: boolean;
  smaNqPeriod: number;
  smaNqBuffer: number;
  smaNqEnabled: boolean;
  /** If true, deliver a push every market close regardless of whether the SMA signal changed. */
  notifyEveryClose: boolean;
};

export type SmaSignalSnapshot = {
  sp500: SmaSignalResult;
  nasdaq100: SmaSignalResult;
  timestamp: string;
};

const DEFAULT_SMA_SIGNAL_CONFIG: SmaSignalConfig = {
  smaSpPeriod: getDefaultSmaPeriod("sp500"),
  smaSpBuffer: getDefaultSmaBuffer("sp500"),
  smaSpEnabled: true,
  smaNqPeriod: getDefaultSmaPeriod("nasdaq100"),
  smaNqBuffer: getDefaultSmaBuffer("nasdaq100"),
  smaNqEnabled: true,
  notifyEveryClose: false,
};

const DEFAULT_LOOKBACK_YEARS = 2;

export function getDefaultSmaSignalConfig(): SmaSignalConfig {
  return { ...DEFAULT_SMA_SIGNAL_CONFIG };
}

export function buildSmaSignalConfigFingerprint(config: SmaSignalConfig): string {
  return [
    config.smaSpPeriod,
    config.smaSpBuffer,
    config.smaSpEnabled ? "1" : "0",
    config.smaNqPeriod,
    config.smaNqBuffer,
    config.smaNqEnabled ? "1" : "0",
    config.notifyEveryClose ? "1" : "0",
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
  return `${getSmaRegimeLabel(result)} (${formatSignedPercent(result.percentDiff)})`;
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
  return parts.length > 0 ? parts.join("; ") : "No alerts enabled";
}

export function describeSmaSignalConfig(config: SmaSignalConfig): string {
  const parts = [];
  if (config.smaSpEnabled) {
    parts.push(`SPX ${config.smaSpPeriod} SMA, ${formatCompactPercent(config.smaSpBuffer)}`);
  }
  if (config.smaNqEnabled) {
    parts.push(`NDX ${config.smaNqPeriod} SMA, ${formatCompactPercent(config.smaNqBuffer)}`);
  }
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

  return {
    sp500: getSmaSignal(sp500Prices, config.smaSpPeriod, config.smaSpBuffer),
    nasdaq100: getSmaSignal(nasdaqPrices, config.smaNqPeriod, config.smaNqBuffer),
    timestamp,
  };
}

function buildIndexChange(current: SmaSignalResult, previous: SmaSignalResult): boolean {
  return getSmaRegime(current) !== getSmaRegime(previous);
}

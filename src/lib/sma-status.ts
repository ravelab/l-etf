import storage, { type DailyPrice } from "@/lib/data/storage";
import {
  DEFAULT_SMA_INFLATION_ADJUSTED,
  getDefaultSmaLowerBuffer,
  getDefaultSmaPeriod,
  getDefaultSmaUpperBuffer,
  getInflationAdjustedDefaultSmaBand,
} from "@/lib/simulation/defaults";
import { getSmaSignal, type SmaRegime, type SmaSignalResult } from "@/lib/sma-signals";
import { volGateParamsTextFor } from "@/lib/simulation/vol-gate";
import { rsiBrakeParamsTextFor } from "@/lib/simulation/rsi-brake";
import { describeSmaRiskOffGates, smaRiskOffGates } from "@/lib/simulation/risk-off-gates";
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
  /** Risk-off gate switch (volatility gate + RSI crash brake, see risk-off-gates.ts) on top of both SMAs. Absent on older stored subscriptions. */
  smaVolGate?: boolean;
  smaSpHigherTurnover?: boolean;
  smaNqHigherTurnover?: boolean;
  /** Run both SMA bands on the CPI-deflated index (`cpi-deflator.ts`). Absent on older stored subscriptions. */
  smaInflationAdjusted?: boolean;
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

function bandFor(index: IndexKey, inflationAdjusted: boolean) {
  return inflationAdjusted
    ? getInflationAdjustedDefaultSmaBand(index)
    : { smaPeriod: getDefaultSmaPeriod(index), smaUpperBuffer: getDefaultSmaUpperBuffer(index), smaLowerBuffer: getDefaultSmaLowerBuffer(index) };
}

const DEFAULT_LOOKBACK_YEARS = 2;

/**
 * The default signal rule: the site's (inflation-adjusted) band with its flag, or the
 * nominal pair for callers requesting nominal signals. Band and flag
 * always come from the same calibration set.
 */
export function getDefaultSmaSignalConfig(inflationAdjusted = DEFAULT_SMA_INFLATION_ADJUSTED): SmaSignalConfig {
  const sp = bandFor("sp500", inflationAdjusted);
  const nq = bandFor("nasdaq100", inflationAdjusted);
  return {
    smaSpPeriod: sp.smaPeriod,
    smaSpUpperBuffer: sp.smaUpperBuffer,
    smaSpLowerBuffer: sp.smaLowerBuffer,
    smaSpEnabled: true,
    smaNqPeriod: nq.smaPeriod,
    smaNqUpperBuffer: nq.smaUpperBuffer,
    smaNqLowerBuffer: nq.smaLowerBuffer,
    smaNqEnabled: true,
    smaVolGate: true,
    smaInflationAdjusted: inflationAdjusted,
    notifyEveryClose: false,
    useCalibratedDefaults: false,
  };
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
    ...(config.smaVolGate && config.smaSpHigherTurnover ? ["sp-alt3"] : []),
    ...(config.smaVolGate && config.smaNqHigherTurnover ? ["nq-alt3"] : []),
    ...(config.smaInflationAdjusted ? ["ia"] : []),
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

function getSmaRegime(result: SmaSignalResult): SmaRegime {
  if (result.signal === "sell") return "risk-off";
  if (result.signal === "buy") return "risk-on";
  // Older persisted notifications encoded the remembered regime in the label.
  return result.regime ?? (result.signalLabel === "Sell L-ETFs" ? "risk-off" : "risk-on");
}

function getSmaRegimeLabel(result: SmaSignalResult): string {
  if (result.signal === "hold" && (result.signalLabel === "Buy L-ETFs" || result.signalLabel === "Sell L-ETFs")) return "Hold";
  if (result.signalLabel === "Buy") return "Buy L-ETFs";
  if (result.signalLabel === "Sell") return "Sell L-ETFs";
  return result.signalLabel;
}

function formatSmaStatus(result: SmaSignalResult): string {
  const vol = result.volatility != null && Number.isFinite(result.volatility)
    ? `, vol ${Math.round(result.volatility * 100)}%` : "";
  // An inflation-adjusted band's gap is to the real SMA.
  const real = result.inflationAdjusted ? " real" : "";
  return `${getSmaRegimeLabel(result)} (${formatSignedPercent(result.percentDiff)}${real}${vol})`;
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
  return parts.join("; ");
}

/** The gate-switch label (vol gate + RSI brake) for the indices this config alerts on. */
function volGateLabelFor(config: SmaSignalConfig): string {
  const enabled: IndexKey[] = [
    ...(config.smaSpEnabled !== false ? (["sp500"] as const) : []),
    ...(config.smaNqEnabled !== false ? (["nasdaq100"] as const) : []),
  ];
  if (config.smaSpHigherTurnover || config.smaNqHigherTurnover) {
    return enabled.map((index) => index === "sp500"
      ? `SPX ${describeSmaRiskOffGates(index, config.smaSpHigherTurnover)}`
      : `NDX ${describeSmaRiskOffGates(index, config.smaNqHigherTurnover)}`).join("; ");
  }
  return `vol ${volGateParamsTextFor(enabled)}; ${rsiBrakeParamsTextFor(enabled)}`;
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
  if (parts.length > 0 && config.smaInflationAdjusted) parts.push("inflation adjusted");
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

export class SmaMarketDataUnavailable extends Error {}

export async function loadCurrentSmaSignals(overrides: Partial<SmaSignalConfig> = {}) {
  const config = { ...getDefaultSmaSignalConfig(overrides.smaInflationAdjusted), ...overrides };
  const marketData = await fetchSmaMarketData();
  const signals = computeSmaSignalSnapshot({ ...marketData, config });
  return { ...marketData, config, signals };
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
    throw new SmaMarketDataUnavailable(`SPX price data unavailable for ${startDate} to ${endDate}.`);
  }
  if (nasdaqPrices.length === 0) {
    throw new SmaMarketDataUnavailable(`NDX price data unavailable for ${startDate} to ${endDate}.`);
  }

  return { sp500Prices, nasdaqPrices };
}

export async function getCurrentSmaSignalSnapshot(
  config: SmaSignalConfig = getDefaultSmaSignalConfig(),
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
  const options = (index: IndexKey) => ({
    ...(config.smaVolGate === true ? smaRiskOffGates(index, index === "sp500" ? config.smaSpHigherTurnover : config.smaNqHigherTurnover) : {}),
    ...(config.smaInflationAdjusted === true ? { inflationAdjusted: true } : {}),
  });

  return {
    sp500: getSmaSignal(sp500Prices, config.smaSpPeriod, { upper: config.smaSpUpperBuffer, lower: config.smaSpLowerBuffer }, options("sp500")),
    nasdaq100: getSmaSignal(nasdaqPrices, config.smaNqPeriod, { upper: config.smaNqUpperBuffer, lower: config.smaNqLowerBuffer }, options("nasdaq100")),
    timestamp,
  };
}

function buildIndexChange(current: SmaSignalResult, previous: SmaSignalResult): boolean {
  return getSmaRegime(current) !== getSmaRegime(previous);
}

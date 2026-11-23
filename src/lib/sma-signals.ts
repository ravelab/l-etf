import { computeSma } from "@/lib/simulation/sma";
import { cpiDeflatorForDates } from "@/lib/simulation/cpi-deflator";
import { computeRealizedVol, nextVolGateRiskOff, type VolGateParams } from "@/lib/simulation/vol-gate";
import { computeWilderRsi, nextRsiBrakeRiskOff, type RsiBrakeParams } from "@/lib/simulation/rsi-brake";
import { DailyPrice } from "@/lib/data/storage/types";

type SmaSignal = "buy" | "sell" | "hold";
export type SmaRegime = "risk-on" | "risk-off";

export interface SmaSignalResult {
  signal: SmaSignal;
  regime?: SmaRegime;
  indexValue: number;
  indexDate: string;
  smaValue: number;
  percentDiff: number;
  signalLabel: string;
  signalEmoji: string;
  /** Present only when the volatility gate was requested. */
  volatility?: number;
  volGateRiskOff?: boolean;
  /** Present only when the RSI crash brake was requested. */
  rsi?: number;
  rsiBrakeRiskOff?: boolean;
  /**
   * Present only when the band ran on the CPI-deflated index: `smaValue` is then the
   * real SMA in the latest CPI's dollars, and `percentDiff` the real gap to it.
   */
  inflationAdjusted?: true;
}

/**
 * Compute SMA signal based on current price vs SMA with buffer zone.
 *
 * Signal logic:
 * - Buy: Price crosses above SMA × (1 + buffer%)
 * - Sell: Price crosses below SMA × (1 - buffer%)
 * - Hold: Price within buffer zone
 *
 * With `volGate`, a tripped volatility gate overrides all three with "sell";
 * with `rsiBrake`, so does a tripped RSI crash brake. Both are the same state
 * machines `generateSmaSignals` runs, replayed over the whole series.
 */
export function getSmaSignal(
  prices: DailyPrice[],
  period: number,
  buffer: { upper: number; lower: number },
  options: { volGate?: VolGateParams; rsiBrake?: RsiBrakeParams; inflationAdjusted?: boolean } = {}
): SmaSignalResult {
  const upperPercent = buffer.upper;
  const lowerPercent = buffer.lower;
  if (prices.length === 0 || period <= 0) {
    return {
      signal: "hold",
      indexValue: 0,
      indexDate: "",
      smaValue: 0,
      percentDiff: 0,
      signalLabel: "No Data",
      signalEmoji: "⏸️",
    };
  }

  const missingClose = prices.find((p) => !isFinite(p.close ?? NaN));
  if (missingClose) {
    throw new Error(`Missing close price for ${missingClose.name} on ${missingClose.date}`);
  }

  const priceIndex = prices.map((p) => p.close as number);
  // Inflation adjusted: the band runs on the CPI-deflated index, as in
  // `generateSmaSignals`; the reported SMA is re-inflated to today's dollars.
  const deflator = options.inflationAdjusted ? cpiDeflatorForDates(prices.map((p) => p.date)) : null;
  const bandPrices = deflator ? priceIndex.map((price, i) => price / deflator[i]) : priceIndex;

  const currentPrice = priceIndex[priceIndex.length - 1];
  const currentBandPrice = bandPrices[bandPrices.length - 1];
  const indexDate = prices[prices.length - 1].date;
  const smaValues = computeSma(bandPrices, period);
  const currentBandSma = smaValues[smaValues.length - 1];
  const currentSma = deflator ? currentBandSma * deflator[deflator.length - 1] : currentBandSma;

  if (!isFinite(currentSma) || currentSma === 0) {
    return {
      signal: "hold",
      indexValue: currentPrice,
      indexDate,
      smaValue: 0,
      percentDiff: 0,
      signalLabel: "Insufficient Data",
      signalEmoji: "⏸️",
    };
  }

  const percentDiff = ((currentBandPrice - currentBandSma) / currentBandSma) * 100;
  const upperDecimal = upperPercent / 100;
  const lowerDecimal = lowerPercent / 100;

  // Determine current position by finding the last time price crossed outside the buffer zone
  let lastPosition: SmaRegime = "risk-on";
  for (let i = priceIndex.length - 1; i >= 0; i--) {
    const sma = smaValues[i];
    if (!isFinite(sma) || sma === 0) break;
    const price = bandPrices[i];
    if (price > sma * (1 + upperDecimal)) {
      lastPosition = "risk-on";
      break;
    }
    if (price < sma * (1 - lowerDecimal)) {
      lastPosition = "risk-off";
      break;
    }
  }

  let signal: SmaSignal = "hold";
  let signalLabel = "Hold";
  let signalEmoji = "⏸️";

  if (currentBandPrice > currentBandSma * (1 + upperDecimal)) {
    signal = "buy";
    signalLabel = "Buy";
    signalEmoji = "🟢";
  } else if (currentBandPrice < currentBandSma * (1 - lowerDecimal)) {
    signal = "sell";
    signalLabel = "Sell";
    signalEmoji = "🔴";
  }

  const volState = options.volGate ? volGateState(priceIndex, options.volGate) : null;
  const brakeState = options.rsiBrake ? rsiBrakeState(priceIndex, options.rsiBrake) : null;
  // The vol gate names the sell when both are tripped: it is the broader rule.
  const gateLabel = volState?.riskOff ? "Sell L-ETFs: High Vol" : brakeState?.riskOff ? "Sell L-ETFs: RSI Brake" : null;
  if (gateLabel) {
    signal = "sell";
    signalLabel = gateLabel;
    signalEmoji = "🔴";
  }

  return {
    signal,
    regime: signal === "sell" ? "risk-off" : lastPosition,
    indexValue: currentPrice,
    indexDate,
    smaValue: currentSma,
    percentDiff,
    signalLabel,
    signalEmoji,
    ...(volState ? { volatility: volState.value, volGateRiskOff: volState.riskOff } : {}),
    ...(brakeState ? { rsi: brakeState.value, rsiBrakeRiskOff: brakeState.riskOff } : {}),
    ...(deflator ? { inflationAdjusted: true as const } : {}),
  };
}

function volGateState(prices: number[], gate: VolGateParams): { value: number; riskOff: boolean } {
  const vol = computeRealizedVol(prices, gate.windowDays);
  let riskOff = false;
  for (const v of vol) riskOff = nextVolGateRiskOff(riskOff, v, gate);
  return { value: vol[vol.length - 1], riskOff };
}

function rsiBrakeState(prices: number[], brake: RsiBrakeParams): { value: number; riskOff: boolean } {
  const rsi = computeWilderRsi(prices, brake.periodDays);
  let riskOff = false;
  for (const r of rsi) riskOff = nextRsiBrakeRiskOff(riskOff, r, brake);
  return { value: rsi[rsi.length - 1], riskOff };
}

import { computeSma } from "@/lib/simulation/sma";
import { DailyPrice } from "@/lib/data/storage/types";

export type SmaSignal = "buy" | "sell" | "hold";

export interface SmaSignalResult {
  signal: SmaSignal;
  indexValue: number;
  indexDate: string;
  smaValue: number;
  percentDiff: number;
  signalLabel: string;
  signalEmoji: string;
}

/**
 * Compute SMA signal based on current price vs SMA with buffer zone.
 *
 * Signal logic:
 * - Buy: Price crosses above SMA × (1 + buffer%)
 * - Sell: Price crosses below SMA × (1 - buffer%)
 * - Hold: Price within buffer zone
 */
export function getSmaSignal(
  prices: DailyPrice[],
  period: number,
  bufferPercent: number
): SmaSignalResult {
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

  const currentPrice = priceIndex[priceIndex.length - 1];
  const indexDate = prices[prices.length - 1].date;
  const smaValues = computeSma(priceIndex, period);
  const currentSma = smaValues[smaValues.length - 1];

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

  const percentDiff = ((currentPrice - currentSma) / currentSma) * 100;
  const bufferDecimal = bufferPercent / 100;

  // Determine current position by finding the last time price crossed outside the buffer zone
  let lastPosition: "risk-on" | "risk-off" = "risk-on";
  for (let i = priceIndex.length - 1; i >= 0; i--) {
    const sma = smaValues[i];
    if (!isFinite(sma) || sma === 0) break;
    const price = priceIndex[i];
    if (price > sma * (1 + bufferDecimal)) {
      lastPosition = "risk-on";
      break;
    }
    if (price < sma * (1 - bufferDecimal)) {
      lastPosition = "risk-off";
      break;
    }
  }

  let signal: SmaSignal = "hold";
  let signalLabel = lastPosition === "risk-on" ? "Buy L-ETFs" : "Sell L-ETFs";
  let signalEmoji = lastPosition === "risk-on" ? "🟢" : "🔴";

  if (currentPrice > currentSma * (1 + bufferDecimal)) {
    signal = "buy";
    signalLabel = "Buy";
    signalEmoji = "🟢";
  } else if (currentPrice < currentSma * (1 - bufferDecimal)) {
    signal = "sell";
    signalLabel = "Sell";
    signalEmoji = "🔴";
  }

  return {
    signal,
    indexValue: currentPrice,
    indexDate,
    smaValue: currentSma,
    percentDiff,
    signalLabel,
    signalEmoji,
  };
}

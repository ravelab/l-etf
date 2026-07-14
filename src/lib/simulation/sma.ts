import type { SmaSignal } from "./types";
import { CONSTANT_SMA_CHECK_FREQUENCY } from "../constants";

/**
 * WeakMap-based SMA cache: same prices array reference + same period → same result.
 * In parameter sweeps, the same window prices are reused across all parameter values,
 * so this avoids redundant O(n) sliding window computations.
 */
const smaCache = new WeakMap<number[], Map<number, number[]>>();

/**
 * Compute Simple Moving Average values for a price series.
 * Returns an array of the same length as prices, with NaN for positions
 * where there's not enough data.
 *
 * Results are cached by (prices array identity, period) so that parameter
 * sweeps that reuse the same window prices avoid redundant computation.
 */
export function computeSma(prices: number[], period: number): number[] {
  let byPeriod = smaCache.get(prices);
  if (byPeriod) {
    const cached = byPeriod.get(period);
    if (cached) return cached;
  }

  const result: number[] = new Array(prices.length);
  let sum = 0;

  for (let i = 0; i < prices.length; i++) {
    sum += prices[i];
    if (i >= period) {
      sum -= prices[i - period];
    }
    if (i >= period - 1) {
      result[i] = sum / period;
    } else {
      result[i] = NaN;
    }
  }

  if (!byPeriod) {
    byPeriod = new Map();
    smaCache.set(prices, byPeriod);
  }
  byPeriod.set(period, result);
  return result;
}

/**
 * Generate SMA buy/sell signals.
 *
 * Re-enter when price crosses above SMA * (1 + buffer.upper / 100).
 * Exit when price crosses below SMA * (1 - buffer.lower / 100).
 *
 * checkFrequency: only check every N trading days.
 */
const signalCache = new WeakMap<number[], Map<string, { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] }>>();

export function generateSmaSignals(
  dates: string[],
  prices: number[],
  smaPeriod: number,
  buffer: { upper: number; lower: number },
  options?: { initialInvested?: boolean }
): { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] } {
  const { upper: upperBufferPct, lower: lowerBufferPct } = buffer;
  const initialInvested = options?.initialInvested ?? true;
  const cacheKey = `${smaPeriod}|${upperBufferPct}|${lowerBufferPct}|${initialInvested}`;
  let byPrices = signalCache.get(prices);
  if (byPrices) {
    const cached = byPrices.get(cacheKey);
    if (cached) return cached;
  }

  const smaValues = computeSma(prices, smaPeriod);
  const signals: SmaSignal[] = [];
  const invested: boolean[] = new Array(dates.length);

  // Default to invested (or the caller-supplied seed — e.g. the History Wrap
  // tail simulation seeds this from the real simulation's regime at the join
  // so a hysteretic buffer band doesn't restart risk-on regardless of the
  // real state). During the warm-up period (before full SMA is available),
  // use a progressive average of all data so far as a proto-SMA. This keeps the
  // strategy "on" when there's no SMA line (user's request) while still providing
  // trend-following protection — a short progressive average will trigger sell
  // signals if the market drops significantly from its recent average.
  let isInvested = initialInvested;
  let daysSinceCheck = 0;
  let warmUpSum = 0;

  for (let i = 0; i < dates.length; i++) {
    warmUpSum += prices[i];

    // Use full SMA when available; otherwise progressive average of all data so far
    const effectiveSma = !isNaN(smaValues[i])
      ? smaValues[i]
      : i >= 1
        ? warmUpSum / (i + 1)
        : NaN;

    if (isNaN(effectiveSma)) {
      invested[i] = isInvested;
      continue;
    }

    daysSinceCheck++;
    if (daysSinceCheck >= CONSTANT_SMA_CHECK_FREQUENCY) {
      daysSinceCheck = 0;

      const upperBand = effectiveSma * (1 + upperBufferPct / 100);
      const lowerBand = effectiveSma * (1 - lowerBufferPct / 100);

      if (!isInvested && prices[i] > upperBand) {
        isInvested = true;
        signals.push({ date: dates[i], type: "buy", price: prices[i] });
      } else if (isInvested && prices[i] < lowerBand) {
        isInvested = false;
        signals.push({ date: dates[i], type: "sell", price: prices[i] });
      }
    }

    invested[i] = isInvested;
  }

  const result = { signals, smaValues, invested };
  if (!byPrices) {
    byPrices = new Map();
    signalCache.set(prices, byPrices);
  }
  byPrices.set(cacheKey, result);
  return result;
}

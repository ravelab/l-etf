import type { SmaSignal } from "./types";
import { CONSTANT_SMA_CHECK_FREQUENCY } from "../constants";
import { SMA_CACHE_MAX_ENTRIES, boundedCacheGet, boundedCacheSet } from "./bounded-cache";
import { computeRealizedVol, nextVolGateRiskOff, type VolGateParams } from "./vol-gate";
import { computeWilderRsi, nextRsiBrakeRiskOff, type RsiBrakeParams } from "./rsi-brake";

/**
 * WeakMap-based SMA cache: same prices array reference + same period → same result.
 * In parameter sweeps, the same window prices are reused across all parameter values,
 * so this avoids redundant O(n) sliding window computations.
 *
 * The inner Map is LRU-bounded: the WeakMap key is the price series, which
 * stays alive for a whole sweep, so an unbounded inner Map grows once per
 * distinct period and each entry retains a full-length series. See
 * `bounded-cache.ts`.
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
    const cached = boundedCacheGet(byPeriod, period);
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
  boundedCacheSet(byPeriod, period, result, SMA_CACHE_MAX_ENTRIES);
  return result;
}

/**
 * Generate SMA buy/sell signals.
 *
 * Re-enter when price crosses above SMA * (1 + buffer.upper / 100).
 * Exit when price crosses below SMA * (1 - buffer.lower / 100).
 *
 * checkFrequency: only check every N trading days.
 *
 * volGate: additionally hold risk-off while a volatility gate with these
 * parameters (`vol-gate.ts`, per index) is tripped. `signals` and `invested` describe the combined
 * position, so a gate exit is a "sell" and a gate release back into an
 * invested SMA regime is a "buy".
 *
 * rsiBrake: likewise hold risk-off while the RSI crash brake (`rsi-brake.ts`)
 * is tripped. Callers resolve both from the gate switch via `smaRiskOffGates`.
 * With either layer on, each signal names what moved the position: "sma" when
 * the band was crossed that close, else "vol", else "rsi".
 */
const signalCache = new WeakMap<number[], Map<string, { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] }>>();

export function generateSmaSignals(
  dates: string[],
  prices: number[],
  smaPeriod: number,
  buffer: { upper: number; lower: number },
  options?: { initialInvested?: boolean; seedAtIndex?: number; volGate?: VolGateParams; rsiBrake?: RsiBrakeParams }
): { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] } {
  const { upper: upperBufferPct, lower: lowerBufferPct } = buffer;
  const initialInvested = options?.initialInvested ?? true;
  const seedAtIndex = options?.seedAtIndex ?? 0;
  const volGate = options?.volGate;
  const rsiBrake = options?.rsiBrake;
  const gateKey = volGate ? `${volGate.windowDays}/${volGate.exitAbove}/${volGate.reenterBelow}` : "off";
  const brakeKey = rsiBrake ? `${rsiBrake.periodDays}/${rsiBrake.exitBelow}/${rsiBrake.reenterAbove}` : "off";
  const cacheKey = `${smaPeriod}|${upperBufferPct}|${lowerBufferPct}|${initialInvested}|${seedAtIndex}|${gateKey}|${brakeKey}`;
  let byPrices = signalCache.get(prices);
  if (byPrices) {
    const cached = boundedCacheGet(byPrices, cacheKey);
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
  const vol = volGate ? computeRealizedVol(prices, volGate.windowDays) : null;
  let gateRiskOff = false;
  const rsi = rsiBrake ? computeWilderRsi(prices, rsiBrake.periodDays) : null;
  let brakeRiskOff = false;
  let position = initialInvested;

  for (let i = 0; i < dates.length; i++) {
    warmUpSum += prices[i];

    if (i === seedAtIndex) {
      isInvested = initialInvested;
      gateRiskOff = false;
      brakeRiskOff = false;
      position = initialInvested;
      daysSinceCheck = 0;
    }

    // Use full SMA when available; otherwise progressive average of all data so far
    const effectiveSma = !isNaN(smaValues[i])
      ? smaValues[i]
      : i >= 1
        ? warmUpSum / (i + 1)
        : NaN;

    if (i < seedAtIndex || isNaN(effectiveSma)) {
      invested[i] = position;
      continue;
    }

    const wasInvested = isInvested;
    const wasGateRiskOff = gateRiskOff;
    daysSinceCheck++;
    if (daysSinceCheck >= CONSTANT_SMA_CHECK_FREQUENCY) {
      daysSinceCheck = 0;

      const upperBand = effectiveSma * (1 + upperBufferPct / 100);
      const lowerBand = effectiveSma * (1 - lowerBufferPct / 100);

      if (!isInvested && prices[i] > upperBand) {
        isInvested = true;
      } else if (isInvested && prices[i] < lowerBand) {
        isInvested = false;
      }
    }

    if (vol && volGate) gateRiskOff = nextVolGateRiskOff(gateRiskOff, vol[i], volGate);
    if (rsi && rsiBrake) brakeRiskOff = nextRsiBrakeRiskOff(brakeRiskOff, rsi[i], rsiBrake);
    const nextPosition = isInvested && !gateRiskOff && !brakeRiskOff;
    if (nextPosition !== position) {
      position = nextPosition;
      const trigger = isInvested !== wasInvested ? "sma" : gateRiskOff !== wasGateRiskOff ? "vol" : "rsi";
      signals.push({
        date: dates[i],
        type: nextPosition ? "buy" : "sell",
        price: prices[i],
        ...(vol || rsi ? { trigger } : {}),
      });
    }

    invested[i] = position;
  }

  const result = { signals, smaValues, invested };
  if (!byPrices) {
    byPrices = new Map();
    signalCache.set(prices, byPrices);
  }
  boundedCacheSet(byPrices, cacheKey, result, SMA_CACHE_MAX_ENTRIES);
  return result;
}

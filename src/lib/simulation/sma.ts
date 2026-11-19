import type { SmaSignal } from "./types";
import { CONSTANT_SMA_CHECK_FREQUENCY } from "../constants";
import { cpiDeflatorForDates } from "./cpi-deflator";
import { SMA_CACHE_MAX_ENTRIES, boundedCacheGet, boundedCacheSet } from "./bounded-cache";
import { computeRealizedVol, nextVolGateRiskOff, type VolGateParams } from "./vol-gate";
import { computeWilderRsi, nextRsiBrakeRiskOff, type RsiBrakeParams } from "./rsi-brake";
import {
  INITIAL_VOL_SHOCK_STATE,
  computeVolShockRatio,
  nextVolShockState,
  type VolShockGateParams,
} from "./vol-shock-gate";

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
 *
 * shockGate: likewise hold risk-off while the volatility-shock gate
 * (`vol-shock-gate.ts`) is tripped. No default switch turns it on; only the
 * signal rule that names it does.
 *
 * With any layer on, each signal names what moved the position: "sma" when
 * the band was crossed that close, else "vol", else "rsi", else "shock".
 */
const signalCache = new WeakMap<number[], Map<string, { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] }>>();

const realPriceCache = new WeakMap<number[], number[]>();

/** Prices over the CPI known on each day; cached per price series so its SMA is too. */
function realPricesFor(prices: number[], deflator: number[]): number[] {
  let real = realPriceCache.get(prices);
  if (!real || real.length !== prices.length) {
    real = prices.map((price, i) => price / deflator[i]);
    realPriceCache.set(prices, real);
  }
  return real;
}

export function generateSmaSignals(
  dates: string[],
  prices: number[],
  smaPeriod: number,
  buffer: { upper: number; lower: number },
  options?: {
    initialInvested?: boolean;
    seedAtIndex?: number;
    volGate?: VolGateParams;
    rsiBrake?: RsiBrakeParams;
    shockGate?: VolShockGateParams;
    /**
     * Run the band on the index deflated by the CPI known on each day
     * (`cpi-deflator.ts`): the price and its SMA are both in real terms, so the
     * band demands a real gain to stay in. `smaValues` come back re-inflated to
     * each day's dollars so they still plot against the nominal price.
     */
    inflationAdjusted?: boolean;
  }
): { signals: SmaSignal[]; smaValues: number[]; invested: boolean[] } {
  const { upper: upperBufferPct, lower: lowerBufferPct } = buffer;
  const initialInvested = options?.initialInvested ?? true;
  const seedAtIndex = options?.seedAtIndex ?? 0;
  const volGate = options?.volGate;
  const rsiBrake = options?.rsiBrake;
  const shockGate = options?.shockGate;
  const gateKey = volGate ? `${volGate.windowDays}/${volGate.exitAbove}/${volGate.reenterBelow}` : "off";
  const brakeKey = rsiBrake ? `${rsiBrake.periodDays}/${rsiBrake.exitBelow}/${rsiBrake.reenterAbove}` : "off";
  const shockKey = shockGate
    ? `|${shockGate.windowDays}/${shockGate.baselineDays}/${shockGate.exitAbove}/${shockGate.reenterBelow}/${shockGate.confirmDays}`
    : "";
  const inflationAdjusted = options?.inflationAdjusted === true;
  const cacheKey = `${smaPeriod}|${upperBufferPct}|${lowerBufferPct}|${initialInvested}|${seedAtIndex}|${gateKey}|${brakeKey}${shockKey}${inflationAdjusted ? "|real" : ""}`;
  let byPrices = signalCache.get(prices);
  if (byPrices) {
    const cached = boundedCacheGet(byPrices, cacheKey);
    if (cached) return cached;
  }

  const deflator = inflationAdjusted ? cpiDeflatorForDates(dates) : null;
  const bandPrices = deflator ? realPricesFor(prices, deflator) : prices;
  const bandSma = computeSma(bandPrices, smaPeriod);
  const smaValues = deflator ? bandSma.map((value, i) => value * deflator[i]) : bandSma;
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
  const shockRatio = shockGate ? computeVolShockRatio(prices, shockGate) : null;
  let shockState = INITIAL_VOL_SHOCK_STATE;
  let position = initialInvested;

  for (let i = 0; i < dates.length; i++) {
    warmUpSum += bandPrices[i];

    if (i === seedAtIndex) {
      isInvested = initialInvested;
      gateRiskOff = false;
      brakeRiskOff = false;
      shockState = INITIAL_VOL_SHOCK_STATE;
      position = initialInvested;
      daysSinceCheck = 0;
    }

    // Use full SMA when available; otherwise progressive average of all data so far
    const effectiveSma = !isNaN(bandSma[i])
      ? bandSma[i]
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

      if (!isInvested && bandPrices[i] > upperBand) {
        isInvested = true;
      } else if (isInvested && bandPrices[i] < lowerBand) {
        isInvested = false;
      }
    }

    if (vol && volGate) gateRiskOff = nextVolGateRiskOff(gateRiskOff, vol[i], volGate);
    const wasBrakeRiskOff = brakeRiskOff;
    if (rsi && rsiBrake) brakeRiskOff = nextRsiBrakeRiskOff(brakeRiskOff, rsi[i], rsiBrake);
    if (shockRatio && shockGate) shockState = nextVolShockState(shockState, shockRatio[i], shockGate);
    const nextPosition = isInvested && !gateRiskOff && !brakeRiskOff && !shockState.riskOff;
    if (nextPosition !== position) {
      position = nextPosition;
      const trigger = isInvested !== wasInvested
        ? "sma"
        : gateRiskOff !== wasGateRiskOff
          ? "vol"
          : brakeRiskOff !== wasBrakeRiskOff || !shockRatio
            ? "rsi"
            : "shock";
      signals.push({
        date: dates[i],
        type: nextPosition ? "buy" : "sell",
        price: prices[i],
        ...(vol || rsi || shockRatio ? { trigger } : {}),
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

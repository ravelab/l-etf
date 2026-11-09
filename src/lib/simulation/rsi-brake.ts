import type { IndexKey } from "./types";

/**
 * RSI crash brake layered on top of the SMA regime and the volatility gate.
 *
 * Wilder RSI over `periodDays` closes of the SMA signal series (the raw index
 * close). The brake forces risk-off once RSI closes below `exitBelow` and
 * releases only once it closes above `reenterAbove`; while released, the SMA
 * band and the volatility gate decide. Like the vol gate it never buys on its
 * own, and its trades are gate trades, not SMA switches, for calibration.
 *
 * It catches slow, grinding sell-offs that the 10-11 day vol gate misses
 * because their daily moves are steady (SPX 2018 Q4, NDX Aug 1990, NDX 1973).
 * RSI(14) < 18 / > 62 was chosen (2026-11) from a full grid of RSI add-ons as
 * the one family that beats the calibrated defaults on both indices without
 * lowering real CAGR in any held-out era (SPX 1885-1926, 1926-1988; NDX
 * 1971-1985 on the since-retired Nasdaq Composite backfill), also with a
 * Treasury-only risk-off. Neighbouring settings
 * (RSI7 < 7, RSI10 < 12, RSI14 < 18-20 with re-entry 44-66) pass too.
 * The evidence is thin: its whole gain comes from those three episodes. It
 * leaves the best vol gate and the calibrated SMA bands unchanged, so the three
 * layers can be tuned independently. Changing it changes every stored result
 * that has the gate switch on.
 */
export interface RsiBrakeParams {
  periodDays: number;
  /** RSI level (0-100) below which the brake forces risk-off. */
  exitBelow: number;
  /** RSI level (0-100) above which a tripped brake releases. */
  reenterAbove: number;
}

export const SMA_RSI_BRAKE: Record<IndexKey, RsiBrakeParams> = {
  sp500: { periodDays: 14, exitBelow: 18, reenterAbove: 62 },
  nasdaq100: { periodDays: 14, exitBelow: 18, reenterAbove: 62 },
};

const INDEX_SHORT_NAME: Record<IndexKey, string> = { sp500: "SPX", nasdaq100: "NDX" };

function rsiBrakeParamsText(index: IndexKey): string {
  const brake = SMA_RSI_BRAKE[index];
  return `RSI ${brake.periodDays}d <${brake.exitBelow} >${brake.reenterAbove}`;
}

/** Parameters for the given indices, written once when they all match. */
export function rsiBrakeParamsTextFor(indices: IndexKey[]): string {
  const texts = indices.map(rsiBrakeParamsText);
  if (texts.every((text) => text === texts[0])) return texts[0] ?? "";
  return indices.map((index, i) => `${INDEX_SHORT_NAME[index]} ${texts[i]}`).join("; ");
}

/** Both indices' parameters, for surfaces where one switch applies both. */
export const SMA_RSI_BRAKE_PARAMS_TEXT = rsiBrakeParamsTextFor(Object.keys(SMA_RSI_BRAKE) as IndexKey[]);

export interface WilderAverages {
  /** Smoothed average gain per close; NaN until `periodDays` changes exist. */
  gain: number[];
  /** Smoothed average loss per close (positive); NaN until `periodDays` changes exist. */
  loss: number[];
}

const averagesCache = new WeakMap<number[], Map<number, WilderAverages>>();

/**
 * Wilder's smoothed average gain and loss. Seeded with the simple mean of the
 * first `periodDays` close-to-close changes, then `(prev × (n − 1) + x) / n`.
 * A non-finite close counts as no change, so one bad row cannot poison every
 * later value.
 */
export function computeWilderAverages(prices: number[], periodDays: number): WilderAverages {
  let byPeriod = averagesCache.get(prices);
  const cached = byPeriod?.get(periodDays);
  if (cached) return cached;

  const n = prices.length;
  const gain = new Array<number>(n).fill(NaN);
  const loss = new Array<number>(n).fill(NaN);
  let g = 0;
  let l = 0;
  for (let i = 1; i < n; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    const change = Number.isFinite(prev) && Number.isFinite(curr) ? curr - prev : 0;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (i <= periodDays) {
      g += up;
      l += down;
      if (i === periodDays) {
        g /= periodDays;
        l /= periodDays;
      }
    } else {
      g = (g * (periodDays - 1) + up) / periodDays;
      l = (l * (periodDays - 1) + down) / periodDays;
    }
    if (i >= periodDays) {
      gain[i] = g;
      loss[i] = l;
    }
  }

  const result = { gain, loss };
  if (!byPeriod) {
    byPeriod = new Map();
    averagesCache.set(prices, byPeriod);
  }
  byPeriod.set(periodDays, result);
  return result;
}

/** RSI from smoothed averages: 100 with no losses, 50 when nothing moved. */
export function rsiFromAverages(gain: number, loss: number): number {
  if (!Number.isFinite(gain) || !Number.isFinite(loss)) return NaN;
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

const rsiCache = new WeakMap<number[], Map<number, number[]>>();

/** Wilder RSI (0-100) per close; NaN until `periodDays` changes exist. */
export function computeWilderRsi(prices: number[], periodDays: number): number[] {
  let byPeriod = rsiCache.get(prices);
  const cached = byPeriod?.get(periodDays);
  if (cached) return cached;
  const { gain, loss } = computeWilderAverages(prices, periodDays);
  const out = gain.map((g, i) => rsiFromAverages(g, loss[i]));
  if (!byPeriod) {
    byPeriod = new Map();
    rsiCache.set(prices, byPeriod);
  }
  byPeriod.set(periodDays, out);
  return out;
}

/** Advance the brake one close. A NaN reading leaves the state unchanged. */
export function nextRsiBrakeRiskOff(riskOff: boolean, rsi: number, brake: RsiBrakeParams): boolean {
  if (!Number.isFinite(rsi)) return riskOff;
  if (!riskOff && rsi < brake.exitBelow) return true;
  if (riskOff && rsi > brake.reenterAbove) return false;
  return riskOff;
}

/** Brake state (true = forced risk-off) at each close. */
export function computeRsiBrakeRiskOff(prices: number[], brake: RsiBrakeParams): boolean[] {
  const rsi = computeWilderRsi(prices, brake.periodDays);
  const out = new Array<boolean>(prices.length);
  let riskOff = false;
  for (let i = 0; i < prices.length; i++) {
    riskOff = nextRsiBrakeRiskOff(riskOff, rsi[i], brake);
    out[i] = riskOff;
  }
  return out;
}

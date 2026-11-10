import { computeRealizedVol } from "./vol-gate";

/**
 * Volatility-shock gate: risk-off while short-window realized volatility runs
 * well above its own long-window level, whatever that level is. Where the vol
 * gate (`vol-gate.ts`) waits for an absolute level, this trips on a calm
 * market turning violent, before the level is reached.
 *
 * The raw state trips once `windowDays` vol closes at or above `exitAbove` x
 * the `baselineDays` vol and releases once it closes below `reenterBelow` x.
 * The held state follows only after the raw state has disagreed with it for
 * `confirmDays` straight closes. The gate never buys on its own.
 *
 * The 3-Gate whitepaper's 20d/250d/1.10x, added to NDX's SMA + vol + RSI,
 * looks free on 1985+ (+1.6pt CAGR, max drawdown 77% -> 51%) but sits on a
 * spike: 1.0x drops CAGR to 26%, and on the 1950-85 NDX proxy nearly every
 * 250-day setting loses CAGR.
 *
 * Searched per index on a 3,564-cell grid (window 10-40d, baseline 120-1000d,
 * exit 1.00-1.50x, re-entry 0.1-0.3x below it, 1-3 close confirmation) against
 * the index's default SMA + vol + RSI on synthetic UPRO/TQQQ (data to
 * 2026-11-02). Each cell is scored as CAGR gain + max drawdown cut / 4 and
 * ranked by the worse of its calibration window and 1950 to that window, taken
 * as the median over its ±1-step neighbourhood on all five axes.
 *
 * NDX: the chosen cell is within 0.1pt of the neighbourhood-score plateau and
 * beats the other plateau cells in every era. It buys drawdown with CAGR
 * rather than for free: 1985-01+ 34.9% -> 33.7% CAGR, 77.5% -> 49.8% max
 * drawdown; 2010+ 41.3% -> 37.6%, 62.1% -> 44.5%; 1950-85 15.8% -> 16.7%,
 * 96.0% -> 79.1%. 1930-85 loses 3.5pt with the drawdown unchanged (1929-32
 * ruins 3x regardless). It switches ~2.7 times a year.
 *
 * SPX has no gate: no cell's neighbourhood beats the default in both windows.
 * The best-looking cell (10d/250d, out 1.4x, back below 1.3x, 2 closes) wins
 * in every era, but only 5 of its 107 neighbours do, so it is a spike.
 */
export interface VolShockGateParams {
  windowDays: number;
  baselineDays: number;
  exitAbove: number;
  reenterBelow: number;
  confirmDays: number;
}

export const NDX_VOL_SHOCK_GATE: VolShockGateParams = {
  windowDays: 20,
  baselineDays: 375,
  exitAbove: 1.2,
  reenterBelow: 0.9,
  confirmDays: 2,
};

export interface VolShockGateState {
  /** Unconfirmed reading: the ratio is past its threshold. */
  tripped: boolean;
  /** Confirmed state the position follows (true = forced risk-off). */
  riskOff: boolean;
  /** Closes in a row the raw reading has disagreed with `riskOff`. */
  streak: number;
}

export const INITIAL_VOL_SHOCK_STATE: VolShockGateState = { tripped: false, riskOff: false, streak: 0 };

/** Short-window over baseline realized volatility; NaN until both windows are full. */
export function computeVolShockRatio(prices: number[], gate: VolShockGateParams): number[] {
  const vol = computeRealizedVol(prices, gate.windowDays);
  const baseline = computeRealizedVol(prices, gate.baselineDays);
  return vol.map((v, i) => (baseline[i] > 0 ? v / baseline[i] : NaN));
}

/** Advance the gate one close. A NaN ratio leaves the raw reading unchanged. */
export function nextVolShockState(state: VolShockGateState, ratio: number, gate: VolShockGateParams): VolShockGateState {
  let tripped = state.tripped;
  if (Number.isFinite(ratio)) {
    if (!tripped && ratio >= gate.exitAbove) tripped = true;
    else if (tripped && ratio < gate.reenterBelow) tripped = false;
  }
  const streak = tripped === state.riskOff ? 0 : state.streak + 1;
  if (streak >= gate.confirmDays) return { tripped, riskOff: tripped, streak: 0 };
  return { tripped, riskOff: state.riskOff, streak };
}

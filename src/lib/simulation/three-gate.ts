import type { SignalRule } from "./signal-rules";
import { computeRealizedVol } from "./vol-gate";

/**
 * "3-Gate": a third-party TQQQ timing rule ("Volatility-Gated Leverage",
 * willperryyy.github.io/tqqq-gate), offered as an extra strategy on the backtest
 * page. It has no SMA. Three gates are read on the NDX close, and all three must
 * pass to hold the LETF:
 *
 * 1. Absolute volatility: 20-day realized vol below 35% annualized.
 * 2. Volatility shock: 20-day vol below 1.10x its own 250-day baseline.
 * 3. Drawdown state: out once the close falls more than 20% below its 250-day
 *    high, back only once it is within 10% of it.
 *
 * The combined verdict must hold for two consecutive closes before the position
 * changes. Parameters are the paper's, not fitted here.
 *
 * Measured on our engine (synthetic TQQQ, T-bill risk-off, 1985-10-02 to
 * 2026-08-14): 34.0% CAGR / -52.5% max drawdown against the paper's 36.6% / -46.8%,
 * the gap being our calibrated financing costs. It switches ~2.5 times a year,
 * and 62 of its 102 risk-off spells lasted under 21 trading days.
 */
export interface ThreeGateParams {
  volWindowDays: number;
  volBelow: number;
  baselineWindowDays: number;
  shockBelow: number;
  highWindowDays: number;
  exitDrawdown: number;
  reenterDrawdown: number;
  confirmDays: number;
}

export const THREE_GATE_PARAMS: ThreeGateParams = {
  volWindowDays: 20,
  volBelow: 0.35,
  baselineWindowDays: 250,
  shockBelow: 1.1,
  highWindowDays: 250,
  exitDrawdown: 0.2,
  reenterDrawdown: 0.1,
  confirmDays: 2,
};

/** Highest close over the trailing `window` closes, today included. */
function rollingHigh(closes: number[], window: number): number[] {
  const out = new Array<number>(closes.length);
  const queue: number[] = [];
  let head = 0;
  for (let i = 0; i < closes.length; i++) {
    while (queue.length > head && closes[queue[queue.length - 1]] <= closes[i]) queue.pop();
    queue.push(i);
    if (queue[head] <= i - window) head++;
    out[i] = closes[queue[head]];
  }
  return out;
}

/** Advance the drawdown gate one close (true = out). A NaN reading keeps the state. */
export function nextDrawdownGateOut(out: boolean, drawdown: number, p: ThreeGateParams): boolean {
  if (!Number.isFinite(drawdown)) return out;
  if (!out && drawdown < -p.exitDrawdown) return true;
  if (out && drawdown > -p.reenterDrawdown) return false;
  return out;
}

/** Whether all three gates pass at each close, before confirmation. */
export function computeThreeGateVerdict(closes: number[], p: ThreeGateParams = THREE_GATE_PARAMS): boolean[] {
  const vol = computeRealizedVol(closes, p.volWindowDays);
  const baseline = computeRealizedVol(closes, p.baselineWindowDays);
  const high = rollingHigh(closes, p.highWindowDays);
  const verdict = new Array<boolean>(closes.length);
  let drawdownOut = false;
  for (let i = 0; i < closes.length; i++) {
    drawdownOut = nextDrawdownGateOut(drawdownOut, closes[i] / high[i] - 1, p);
    const calm = vol[i] < p.volBelow;
    const noShock = baseline[i] > 0 && vol[i] / baseline[i] < p.shockBelow;
    // NaN comparisons are false, so no verdict passes before a full baseline window.
    verdict[i] = calm && noShock && !drawdownOut;
  }
  return verdict;
}

/** Hold the position until the verdict has disagreed with it for `confirmDays` straight closes. */
export function confirmThreeGateRegime(verdict: boolean[], confirmDays: number): boolean[] {
  const held = new Array<boolean>(verdict.length);
  let position = false;
  let streak = 0;
  for (let i = 0; i < verdict.length; i++) {
    streak = verdict[i] === position ? 0 : streak + 1;
    if (streak >= confirmDays) {
      position = verdict[i];
      streak = 0;
    }
    held[i] = position;
  }
  return held;
}

export const NDX_THREE_GATE_RULE: SignalRule = {
  id: "ndx-3-gate",
  label: "3-Gate",
  title: "NDX 3-Gate",
  description:
    "Third-party TQQQ rule with no SMA: hold only while NDX 20-day volatility is under 35%, under 1.10x its 250-day " +
    "baseline, and the index has not fallen 20% below its 250-day high (back within 10% to re-enter). A change " +
    "must hold two closes. Switches ~2.5 times a year.",
  sourceUrl: "https://willperryyy.github.io/tqqq-gate/whitepaper.html",
  warmUpDays: Math.max(THREE_GATE_PARAMS.baselineWindowDays, THREE_GATE_PARAMS.highWindowDays) + THREE_GATE_PARAMS.confirmDays,
  indices: ["nasdaq100"],
  regime: (_dates, closes) => confirmThreeGateRegime(computeThreeGateVerdict(closes), THREE_GATE_PARAMS.confirmDays),
};

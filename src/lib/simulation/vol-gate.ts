import type { IndexKey } from "./types";

/**
 * Volatility risk-off gate layered on top of the SMA regime.
 *
 * Realized volatility is the sample standard deviation of the last
 * `windowDays` daily log returns of the SMA signal series (the raw index
 * close), annualized by √252. The gate forces risk-off once it closes above
 * `exitAbove` and releases only once it closes below `reenterBelow`; while
 * released, the SMA alone decides. The gate never buys on its own.
 *
 * Parameters are per index, picked from a full 1-day/1% grid (window 5-30d,
 * exit 25-90%) under the full-period calibration score, ranked by
 * `stabilityAdjustedSmaScore` over the ±1d/±1% neighbourhood. No shared gate
 * beat the old common 11d 49%/31% on both indices: SPX's best halves NDX's
 * score. SPX 11d 42%/23% is the centre of a 41-43% exit plateau; with it the
 * calibrated band widens its lower buffer and switches far less. NDX's
 * 11d 49%/31% sat one step from a cliff (12d lost 22-36%); 10d 50%/31% keeps
 * its trade count and steps away. The NDX stable argmax, 9d 46%/40%, gained
 * 1% of base score for 43 gate episodes (mostly short 2000-02 flips) and was
 * rejected.
 * Changing either set changes every stored result that has the gate on.
 */
export interface VolGateParams {
  windowDays: number;
  exitAbove: number;
  reenterBelow: number;
}

export const SMA_VOL_GATE: Record<IndexKey, VolGateParams> = {
  sp500: { windowDays: 11, exitAbove: 0.42, reenterBelow: 0.23 },
  nasdaq100: { windowDays: 10, exitAbove: 0.5, reenterBelow: 0.31 },
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

function volGateParamsText(index: IndexKey): string {
  const gate = SMA_VOL_GATE[index];
  return `${gate.windowDays}d ${pct(gate.exitAbove)} ${pct(gate.reenterBelow)}`;
}

const INDEX_SHORT_NAME: Record<IndexKey, string> = { sp500: "SPX", nasdaq100: "NDX" };

/** Parameters for the given indices, written once when they all match. */
export function volGateParamsTextFor(indices: IndexKey[]): string {
  const texts = indices.map(volGateParamsText);
  if (texts.every((text) => text === texts[0])) return texts[0] ?? "";
  return indices.map((index, i) => `${INDEX_SHORT_NAME[index]} ${texts[i]}`).join("; ");
}

/** Both indices' parameters, for surfaces where one switch gates both. */
export const SMA_VOL_GATE_PARAMS_TEXT = volGateParamsTextFor(Object.keys(SMA_VOL_GATE) as IndexKey[]);

const realizedVolCache = new WeakMap<number[], Map<number, number[]>>();

/** Annualized realized volatility per day; NaN until a full window exists. */
export function computeRealizedVol(prices: number[], windowDays: number): number[] {
  let byWindow = realizedVolCache.get(prices);
  const cached = byWindow?.get(windowDays);
  if (cached) return cached;

  const n = prices.length;
  const out = new Array<number>(n).fill(NaN);
  const returns = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    returns[i] = prev > 0 && curr > 0 && isFinite(prev) && isFinite(curr) ? Math.log(curr / prev) : NaN;
  }

  let sum = 0;
  let sumSq = 0;
  let valid = 0;
  for (let i = 1; i < n; i++) {
    const r = returns[i];
    if (isFinite(r)) {
      sum += r;
      sumSq += r * r;
      valid++;
    }
    const drop = i - windowDays;
    if (drop >= 1) {
      const old = returns[drop];
      if (isFinite(old)) {
        sum -= old;
        sumSq -= old * old;
        valid--;
      }
    }
    if (i >= windowDays && valid === windowDays) {
      const variance = Math.max(0, (sumSq - (sum * sum) / windowDays) / (windowDays - 1));
      out[i] = Math.sqrt(variance * 252);
    }
  }

  if (!byWindow) {
    byWindow = new Map();
    realizedVolCache.set(prices, byWindow);
  }
  byWindow.set(windowDays, out);
  return out;
}

/** Advance the gate one close. A NaN reading leaves the state unchanged. */
export function nextVolGateRiskOff(riskOff: boolean, vol: number, gate: VolGateParams): boolean {
  if (!isFinite(vol)) return riskOff;
  if (!riskOff && vol > gate.exitAbove) return true;
  if (riskOff && vol < gate.reenterBelow) return false;
  return riskOff;
}

/** Gate state (true = forced risk-off) at each close. */
export function computeVolGateRiskOff(prices: number[], gate: VolGateParams): boolean[] {
  const vol = computeRealizedVol(prices, gate.windowDays);
  const out = new Array<boolean>(prices.length);
  let riskOff = false;
  for (let i = 0; i < prices.length; i++) {
    riskOff = nextVolGateRiskOff(riskOff, vol[i], gate);
    out[i] = riskOff;
  }
  return out;
}

/**
 * Volatility risk-off gate layered on top of the SMA regime.
 *
 * Realized volatility is the sample standard deviation of the last
 * `windowDays` daily log returns of the SMA signal series (the raw index
 * close), annualized by √252. The gate forces risk-off once it closes above
 * `exitAbove` and releases only once it closes below `reenterBelow`; while
 * released, the SMA alone decides. The gate never buys on its own.
 *
 * The parameters were picked on NDX 1985–2026 (146-day SMA, −12.2%/+8.2%) to
 * fire roughly once every four years. Changing them changes every stored
 * result that has the gate on.
 */
export const SMA_VOL_GATE = {
  windowDays: 11,
  exitAbove: 0.49,
  reenterBelow: 0.31,
} as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SMA_VOL_GATE_PARAMS_TEXT =
  `${SMA_VOL_GATE.windowDays}, ${pct(SMA_VOL_GATE.exitAbove)}, ${pct(SMA_VOL_GATE.reenterBelow)}`;

export const SMA_VOL_GATE_LABEL = `Volatility risk off (${SMA_VOL_GATE_PARAMS_TEXT})`;

const realizedVolCache = new WeakMap<number[], number[]>();

/** Annualized realized volatility per day; NaN until a full window exists. */
export function computeRealizedVol(prices: number[], windowDays: number = SMA_VOL_GATE.windowDays): number[] {
  if (windowDays === SMA_VOL_GATE.windowDays) {
    const cached = realizedVolCache.get(prices);
    if (cached) return cached;
  }

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

  if (windowDays === SMA_VOL_GATE.windowDays) realizedVolCache.set(prices, out);
  return out;
}

/** Advance the gate one close. A NaN reading leaves the state unchanged. */
export function nextVolGateRiskOff(riskOff: boolean, vol: number): boolean {
  if (!isFinite(vol)) return riskOff;
  if (!riskOff && vol > SMA_VOL_GATE.exitAbove) return true;
  if (riskOff && vol < SMA_VOL_GATE.reenterBelow) return false;
  return riskOff;
}

/** Gate state (true = forced risk-off) at each close. */
export function computeVolGateRiskOff(prices: number[]): boolean[] {
  const vol = computeRealizedVol(prices);
  const out = new Array<boolean>(prices.length);
  let riskOff = false;
  for (let i = 0; i < prices.length; i++) {
    riskOff = nextVolGateRiskOff(riskOff, vol[i]);
    out[i] = riskOff;
  }
  return out;
}

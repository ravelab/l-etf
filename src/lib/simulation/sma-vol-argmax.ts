import type { SignalRule } from "./signal-rules";
import { computeSma, generateSmaSignals } from "./sma";
import { SMA_RSI_BRAKE } from "./rsi-brake";
import type { VolGateParams } from "./vol-gate";

/**
 * NDX's stable-argmax volatility gate, which calibration found and deliberately
 * did not ship (see `SMA_VOL_GATE` in `vol-gate.ts`). On band 136d -17.9%/+9.6%
 * it scored ~6% base / ~3.5% stable higher than the shipped 10d 50%/31%, with
 * +0.6pt real CAGR at the same max drawdown, but traded 42 times instead of 24,
 * the extra 18 being short gate flips mostly in 1998-2003. SPX's own stable-score
 * leader is the shipped 20d 32%/22%; the extra applies the NDX parameters to either index.
 */
export const NDX_ARGMAX_VOL_GATE: VolGateParams = { windowDays: 9, exitAbove: 0.46, reenterBelow: 0.4 };

/**
 * Uses the line's nominal SMA band and index-specific RSI brake, with the vol
 * gate swapped for NDX's highest-scoring alternative.
 */
export const NDX_SMA_VOL_ARGMAX_RULE: SignalRule = {
  id: "ndx-sma-vol-9d",
  label: "SMA Vol 9d",
  title: "SMA Vol 9d 46%/40%",
  description:
    "Uses the line's nominal SMA band and RSI brake. The volatility thresholds come from NDX calibration: " +
    "out above 46% annualized 9-day volatility and back below 40%. On NDX it switched almost twice as often " +
    "as the default, mostly from short risk-off spells in 1998–2003.",
  sourceUrl: "https://github.com/ravelab/l-etf/blob/f183d9cf4cb00f49696875f6c2236584c24af0e0/src/lib/simulation/sma-vol-argmax.ts",
  warmUpDays: NDX_ARGMAX_VOL_GATE.windowDays + 1,
  regime: (dates, closes, line) =>
    generateSmaSignals(
      dates,
      closes,
      line.smaPeriod,
      { upper: line.smaUpperBuffer, lower: line.smaLowerBuffer },
      { volGate: NDX_ARGMAX_VOL_GATE, rsiBrake: SMA_RSI_BRAKE[line.smaIndex] }
    ).invested,
  smaValues: (_dates, closes, line) => computeSma(closes, line.smaPeriod),
};

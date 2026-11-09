import type { SignalRule } from "./signal-rules";
import { computeSma, generateSmaSignals } from "./sma";
import { SMA_RSI_BRAKE } from "./rsi-brake";
import type { VolGateParams } from "./vol-gate";

/**
 * NDX's stable-argmax volatility gate, which calibration found and deliberately
 * did not ship (see `SMA_VOL_GATE` in `vol-gate.ts`). On band 136d -17.9%/+9.6%
 * it scored ~6% base / ~3.5% stable higher than the shipped 10d 50%/31%, with
 * +0.6pt real CAGR at the same max drawdown, but traded 42 times instead of 24,
 * the extra 18 being short gate flips mostly in 1998-2003. SPX has no such
 * variant: its shipped 11d 42%/23% is already its plateau centre.
 */
export const NDX_ARGMAX_VOL_GATE: VolGateParams = { windowDays: 9, exitAbove: 0.46, reenterBelow: 0.4 };

/**
 * The default SMA Vol strategy with only NDX's vol gate swapped for the argmax:
 * the twinned line's own SMA band and the shipped RSI brake are kept, so the two
 * lines differ only in the gate.
 */
export const NDX_SMA_VOL_ARGMAX_RULE: SignalRule = {
  id: "ndx-sma-vol-9d",
  label: "SMA Vol 9d",
  title: "NDX SMA Vol 9d 46%/40%",
  description:
    "The default NDX SMA band and RSI brake, with the vol gate at calibration's rejected optimum: 9-day " +
    "volatility, out above 46%, back below 40% (shipped: 10d 50%/31%). It scored a little higher but trades " +
    "almost twice as often, the extra exits mostly short flips in 1998-2003.",
  warmUpDays: NDX_ARGMAX_VOL_GATE.windowDays + 1,
  indices: ["nasdaq100"],
  regime: (dates, closes, line) =>
    generateSmaSignals(
      dates,
      closes,
      line.smaPeriod,
      { upper: line.smaUpperBuffer, lower: line.smaLowerBuffer },
      { volGate: NDX_ARGMAX_VOL_GATE, rsiBrake: SMA_RSI_BRAKE.nasdaq100 }
    ).invested,
  smaValues: (_dates, closes, line) => computeSma(closes, line.smaPeriod),
};

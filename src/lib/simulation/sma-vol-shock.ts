import type { SignalRule, SignalRuleLine } from "./signal-rules";
import { computeSma, generateSmaSignals } from "./sma";
import { smaRiskOffGates } from "./risk-off-gates";
import { NDX_VOL_SHOCK_GATE } from "./vol-shock-gate";

function run(dates: string[], closes: number[], line: SignalRuleLine) {
  return generateSmaSignals(
    dates,
    closes,
    line.smaPeriod,
    { upper: line.smaUpperBuffer, lower: line.smaLowerBuffer },
    { ...smaRiskOffGates(line.smaIndex), shockGate: NDX_VOL_SHOCK_GATE }
  );
}

/**
 * Uses the line's nominal SMA band and index-specific vol gate and RSI brake,
 * with an additional volatility-shock gate tuned on NDX.
 */
export const NDX_SMA_VOL_SHOCK_RULE: SignalRule = {
  id: "ndx-sma-vol-shock",
  label: "SMA Vol RSI Shock",
  title: "SMA Vol RSI + Volatility Shock",
  description:
    "Adds an NDX-tuned volatility shock gate to the line's nominal SMA band, vol gate and RSI brake. " +
    "Go out when 20-day volatility reaches 1.2× its 375-day level and release below 0.9×. Each change " +
    "requires two consecutive closes.",
  sourceUrl: "https://github.com/ravelab/l-etf/blob/b21c33304a5cb2d9f2e729607aa5f03e5baa3c8a/src/lib/simulation/vol-shock-gate.ts",
  warmUpDays: NDX_VOL_SHOCK_GATE.baselineDays + NDX_VOL_SHOCK_GATE.confirmDays + 1,
  regime: (dates, closes, line) => run(dates, closes, line).invested,
  signals: (dates, closes, line) => run(dates, closes, line).signals,
  smaValues: (_dates, closes, line) => computeSma(closes, line.smaPeriod),
};

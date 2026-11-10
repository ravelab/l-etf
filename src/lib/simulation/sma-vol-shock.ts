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
 * The default NDX SMA Vol strategy (band, vol gate and RSI brake) with the
 * volatility-shock gate added as a further exit, so the two lines differ only in
 * that gate. See `vol-shock-gate.ts` for how its parameters were chosen.
 */
export const NDX_SMA_VOL_SHOCK_RULE: SignalRule = {
  id: "ndx-sma-vol-shock",
  label: "SMA Vol RSI Shock",
  title: "NDX SMA Vol RSI + Shock",
  description:
    "The default NDX SMA band, vol gate and RSI brake, plus a volatility-shock exit: out while 20-day volatility " +
    "is 1.2x or more its 375-day level, back once it is under 0.9x, each change held two closes. It trades about " +
    "a point of CAGR for a much smaller drawdown and switches ~2.7 times a year.",
  warmUpDays: NDX_VOL_SHOCK_GATE.baselineDays + NDX_VOL_SHOCK_GATE.confirmDays + 1,
  indices: ["nasdaq100"],
  regime: (dates, closes, line) => run(dates, closes, line).invested,
  signals: (dates, closes, line) => run(dates, closes, line).signals,
  smaValues: (_dates, closes, line) => computeSma(closes, line.smaPeriod),
};
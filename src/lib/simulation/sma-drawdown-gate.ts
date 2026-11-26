import { cpiDeflatorForDates } from "./cpi-deflator";
import { smaRiskOffGates } from "./risk-off-gates";
import { rollingHigh } from "./rolling-high";
import type { SignalRule, SignalRuleLine } from "./signal-rules";
import { generateSmaSignals } from "./sma";

const LOOKBACK_SESSIONS = 126;
const EXIT_DRAWDOWN = 0.20;
const REENTRY_DRAWDOWN = 0.10;
const CONFIRM_CLOSES = 5;
const MIN_OFF_SESSIONS = 21;

/** Risk-off veto from the index's CPI-deflated closes, independent of the SMA regime. */
export function sixMonthDrawdownRiskOff(realCloses: number[]): boolean[] {
  const highs = rollingHigh(realCloses, LOOKBACK_SESSIONS);
  let offSince: number | undefined;
  let belowExitCloses = 0;

  return realCloses.map((close, i) => {
    const drawdown = close / highs[i] - 1;
    if (offSince === undefined) {
      belowExitCloses = drawdown < -EXIT_DRAWDOWN ? belowExitCloses + 1 : 0;
      if (belowExitCloses >= CONFIRM_CLOSES) {
        offSince = i;
        belowExitCloses = 0;
      }
    } else if (i - offSince >= MIN_OFF_SESSIONS && drawdown > -REENTRY_DRAWDOWN) {
      offSince = undefined;
    }
    return offSince !== undefined;
  });
}

function baseSma(dates: string[], closes: number[], line: SignalRuleLine) {
  return generateSmaSignals(dates, closes, line.smaPeriod, {
    upper: line.smaUpperBuffer,
    lower: line.smaLowerBuffer,
  }, { ...smaRiskOffGates(line.smaIndex), inflationAdjusted: line.smaInflationAdjusted });
}

/**
 * In the 1926-07-01 to 2026-11-23 project backtest, with the calibrated real SMA
 * bands, default risk-off assets, next-open fills and no tax, this gate raised
 * TQQQ real CAGR from 20.30% to 21.14% and trimmed drawdown from 94.48% to
 * 93.90%. Switches stayed at 72. UPRO real CAGR rose from 17.36% to 17.66%
 * with two fewer switches and the same 81.74% drawdown. UPRO's modern path
 * matched the baseline. TQQQ benefited in 2022 and lost ground in 2008.
 */
export const SMA_DRAWDOWN_GATE_RULE: SignalRule = {
  id: "sma-6mo-drawdown",
  label: "SMA Vol RSI + 6mo Drawdown",
  title: "SMA Vol RSI + Six-month Drawdown Gate",
  description:
    "Adds a risk-off gate to the line's SMA, volatility and RSI rules. Five consecutive closes more than " +
    "20% below the inflation-adjusted 126-session high trigger the gate. After at least 21 sessions, " +
    "a close less than 10% below that rolling high lets the base rules decide when to return.",
  sourceUrl: "https://github.com/ravelab/l-etf/blob/main/src/lib/simulation/sma-drawdown-gate.ts",
  warmUpDays: LOOKBACK_SESSIONS,
  regime: (dates, closes, line) => {
    const cpi = cpiDeflatorForDates(dates);
    const drawdownOff = sixMonthDrawdownRiskOff(closes.map((close, i) => close / cpi[i]));
    return baseSma(dates, closes, line).invested.map((invested, i) => invested && !drawdownOff[i]);
  },
  smaValues: (dates, closes, line) => baseSma(dates, closes, line).smaValues,
};

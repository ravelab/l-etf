import type { SignalRule, SignalRuleLine } from "./signal-rules";
import type { SmaSignal } from "./types";
import { generateSmaSignals } from "./sma";
import { smaRiskOffGates } from "./risk-off-gates";
import { rateHikeShockRiskOff } from "./rate-hike-shock";

function run(dates: string[], closes: number[], line: SignalRuleLine) {
  const base = generateSmaSignals(
    dates,
    closes,
    line.smaPeriod,
    { upper: line.smaUpperBuffer, lower: line.smaLowerBuffer },
    { ...smaRiskOffGates(line.smaIndex), ...(line.smaInflationAdjusted ? { inflationAdjusted: true } : {}) }
  );
  const off = rateHikeShockRiskOff(dates);
  const invested = base.invested.map((held, i) => held && !off[i]);
  const baseTriggerByDate = new Map(base.signals.map((s) => [s.date, s.trigger]));
  const signals: SmaSignal[] = [];
  for (let i = 1; i < invested.length; i++) {
    if (invested[i] === invested[i - 1]) continue;
    // The gate moved the position unless the band/gates changed on the same close.
    const trigger = base.invested[i] !== base.invested[i - 1] ? baseTriggerByDate.get(dates[i]) ?? "sma" : "rate";
    signals.push({ date: dates[i], type: invested[i] ? "buy" : "sell", price: closes[i], trigger });
  }
  return { invested, signals, smaValues: base.smaValues };
}

/**
 * The line's default SMA band, vol gate and RSI brake, plus the rate-hike shock
 * (`rate-hike-shock.ts`) as a further exit, so the two lines differ only in that gate.
 */
export const SMA_RATE_SHOCK_RULE: SignalRule = {
  id: "sma-rate-shock",
  label: "SMA Vol RSI Rate",
  title: "SMA Vol RSI + Rate shock",
  description:
    "The default SMA band, vol gate and RSI brake, plus a rate-hike exit: out while the short rate (21-day mean) is " +
    "up more than 2 points on 63 trading days earlier, back once that change turns negative. It has fired 13 times " +
    "since 1885, last in 1982, so it changes nothing after 1985: crash insurance for 1970s-style tightening.",
  sourceUrl: "https://github.com/ravelab/l-etf/blob/44a32af78e483dbea742da11e61dd2cabafac4ca/src/lib/simulation/rate-hike-shock.ts",
  // The twin's own SMA warm-up: the band, vol gate and RSI brake must start from the
  // same first close as the line they twin, and the rate gate reads bundled episodes.
  warmUpDays: 0,
  regime: (dates, closes, line) => run(dates, closes, line).invested,
  signals: (dates, closes, line) => run(dates, closes, line).signals,
  smaValues: (dates, closes, line) => run(dates, closes, line).smaValues,
};

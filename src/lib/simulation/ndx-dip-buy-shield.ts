import { computeWilderRsi } from "./rsi-brake";
import type { SignalRule } from "./signal-rules";
import { computeSma } from "./sma";
import { computeRealizedVol } from "./vol-gate";

const TREND_DAYS = 200;
const SLOPE_DAYS = 50;

function dipBuyShieldRegime(closes: number[]): boolean[] {
  const sma = computeSma(closes, TREND_DAYS);
  const rsi = computeWilderRsi(closes, 10);
  const vol = computeRealizedVol(closes, 10);
  let trendLong = true;
  let dipEntryClose: number | undefined;

  return closes.map((close, i) => {
    if (Number.isFinite(sma[i])) {
      if (trendLong) {
        trendLong = close >= 0.97 * sma[i];
      } else if (close > 1.03 * sma[i]) {
        trendLong = true;
        dipEntryClose = undefined;
      } else if (dipEntryClose !== undefined) {
        if (close <= 0.98 * dipEntryClose) dipEntryClose = undefined;
      } else if (rsi[i] < 30 && sma[i] > sma[i - SLOPE_DAYS]) {
        dipEntryClose = close;
      }
    }

    // As in the source, the shield overrides holdings while the underlying
    // trend and dip state continue to update. The binary version holds SGOV
    // throughout the shield.
    return !(vol[i] > 0.50) && (trendLong || dipEntryClose !== undefined);
  });
}

export const NDX_DIP_BUY_SHIELD_RULE: SignalRule = {
  id: "ndx-dip-buy-shield",
  label: "200d Dip-Buy Shield",
  title: "200-day Dip-Buy Shield (SGOV, binary)",
  description:
    "Uses a nominal 200-day SMA with a ±3% band. While out, RSI(10) below 30 permits a dip buy if the SMA " +
    "is higher than 50 sessions ago. A 2% drop from the index entry signal close stops the dip trade. " +
    "This binary version holds SGOV throughout the shield when 10-day annualized volatility exceeds 50%; " +
    "the original TQQQ rule can return to 50% TQQQ during the shield.",
  sourceUrl: "https://www.reddit.com/r/TQQQ/comments/1y5howd/tqqq_200day_sma_dipbuy_volatility_shield_strategy/",
  warmUpDays: TREND_DAYS + SLOPE_DAYS,
  riskOffAsset: "SGOV",
  regime: (_dates, closes) => dipBuyShieldRegime(closes),
  smaValues: (_dates, closes) => computeSma(closes, TREND_DAYS),
};

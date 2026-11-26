import { computeWilderRsi } from "./rsi-brake";
import type { SignalRule } from "./signal-rules";
import { computeSma } from "./sma";
import { computeRealizedVol } from "./vol-gate";

const TREND_DAYS = 150;

function trendShieldRegime(closes: number[]): boolean[] {
  const sma = computeSma(closes, TREND_DAYS);
  const rsi = computeWilderRsi(closes, 10);
  const vol = computeRealizedVol(closes, 10);
  let trendLong = true;
  let bounceEntry: number | undefined;

  return closes.map((close, i) => {
    if (!Number.isFinite(sma[i])) return true;

    if (trendLong) {
      trendLong = close >= 0.97 * sma[i];
    } else if (close > 1.03 * sma[i] || (bounceEntry !== undefined && close > sma[i])) {
      trendLong = true;
      bounceEntry = undefined;
    } else if (bounceEntry !== undefined) {
      if (close <= 0.98 * bounceEntry) bounceEntry = undefined;
    } else if (rsi[i] < 30) {
      bounceEntry = close;
    }

    // The shield overrides the allocation while the trend and bounce state keep updating.
    return vol[i] <= 0.50 && (trendLong || bounceEntry !== undefined);
  });
}

export const NDX_TREND_SHIELD_RULE: SignalRule = {
  id: "ndx-trend-shield",
  label: "Trend & Shield",
  title: "Trend & Shield (VGSH)",
  description:
    "Binary adaptation of an earlier LETFtest rule using a nominal 150-day SMA with a ±3% band. A bearish RSI(10) reading below 30 starts a " +
    "bounce trade with a 2% stop measured from the index signal close. Above 50% annualized 10-day volatility, " +
    "hold VGSH. Each position is fully in the leveraged ETF or VGSH.",
  sourceUrl: "https://github.com/ravelab/l-etf/blob/47226e5fa7853800a6b6161a6f7ecdc16b476eb0/src/lib/simulation/trend-shield.ts",
  warmUpDays: TREND_DAYS,
  riskOffAsset: "VGSH",
  regime: (_dates, closes) => trendShieldRegime(closes),
  smaValues: (_dates, closes) => computeSma(closes, TREND_DAYS),
};

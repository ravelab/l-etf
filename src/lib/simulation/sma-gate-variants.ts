import type { SignalRule } from "./signal-rules";
import { SMA_RSI_BRAKE } from "./rsi-brake";
import { computeSma, generateSmaSignals } from "./sma";
import { SMA_VOL_GATE } from "./vol-gate";

const SMA_VARIANT_WARM_UP_DAYS = 15;

function smaOptions(index: keyof typeof SMA_VOL_GATE, variant: "sma" | "vol" | "rsi") {
  if (variant === "vol") return { volGate: SMA_VOL_GATE[index] };
  if (variant === "rsi") return { rsiBrake: SMA_RSI_BRAKE[index] };
  return {};
}

function makeSmaVariant(
  id: string,
  label: string,
  title: string,
  description: string,
  variant: "sma" | "vol" | "rsi",
  warmUpDays: number,
): SignalRule {
  return {
    id,
    label,
    title,
    description,
    warmUpDays,
    regime: (dates, closes, line) =>
      generateSmaSignals(
        dates,
        closes,
        line.smaPeriod,
        { upper: line.smaUpperBuffer, lower: line.smaLowerBuffer },
        smaOptions(line.smaIndex, variant),
      ).invested,
    smaValues: (_dates, closes, line) => computeSma(closes, line.smaPeriod),
  };
}

export const SMA_ONLY_RULE = makeSmaVariant(
  "sma-only",
  "SMA",
  "SMA only",
  "The line's SMA band without the volatility gate or RSI crash brake.",
  "sma",
  0,
);

export const SMA_VOL_ONLY_RULE = makeSmaVariant(
  "sma-vol-only",
  "SMA Vol",
  "SMA + Vol only",
  "The line's SMA band with its index-specific volatility gate, without the RSI crash brake.",
  "vol",
  SMA_VARIANT_WARM_UP_DAYS,
);

export const SMA_RSI_ONLY_RULE = makeSmaVariant(
  "sma-rsi-only",
  "SMA RSI",
  "SMA + RSI only",
  "The line's SMA band with the RSI crash brake, without the volatility gate.",
  "rsi",
  SMA_VARIANT_WARM_UP_DAYS,
);

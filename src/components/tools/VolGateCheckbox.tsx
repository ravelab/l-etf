"use client";

import { useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { SMA_VOL_GATE, SMA_VOL_GATE_PARAMS_TEXT, volGateParamsTextFor } from "@/lib/simulation/vol-gate";
import { SMA_RSI_BRAKE, SMA_RSI_BRAKE_PARAMS_TEXT, rsiBrakeParamsTextFor } from "@/lib/simulation/rsi-brake";

const pct = (v: number) => `${Math.round(v * 100)}%`;

const GATE_INDICES = ["sp500", "nasdaq100"] as const;
const GATE_LINE_LABEL = { sp500: "SPX", nasdaq100: "NDX" } as const;
const gateLinesDiffer = new Set(GATE_INDICES.map((index) => volGateParamsTextFor([index]))).size > 1;
const GATE_LINES = gateLinesDiffer
  ? GATE_INDICES.map((index) => `${GATE_LINE_LABEL[index]} ${volGateParamsTextFor([index])}`)
  : [SMA_VOL_GATE_PARAMS_TEXT];

// The brake is shared by both indices today, so it reads as one short stacked
// pair beside the vol lines. Below 13rem the pair cannot fit beside them, so the
// box grows a third line instead of truncating the vol gates away.
const sharedBrake = new Set(GATE_INDICES.map((index) => rsiBrakeParamsTextFor([index]))).size === 1;
const BRAKE_LINES = sharedBrake
  ? [`RSI ${SMA_RSI_BRAKE.sp500.periodDays}d`, `<${SMA_RSI_BRAKE.sp500.exitBelow} >${SMA_RSI_BRAKE.sp500.reenterAbove}`]
  : GATE_INDICES.map((index) => `${GATE_LINE_LABEL[index]} ${rsiBrakeParamsTextFor([index])}`);

export function VolGateCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="@container flex flex-col gap-1">
      <div className="text-xs text-muted font-medium flex items-center gap-1.5">
        <span>Volatility + RSI</span>
        <span className="ml-auto inline-flex items-center">
          <InfoPopoverButton label="Volatility and RSI brake">
            Adds a second risk-off rule on top of each SMA. At every close the index&apos;s realized volatility
            is measured (standard deviation of the last N daily log returns × √252). Above the exit level the
            strategy moves to the risk-off asset even if the SMA says invested; it stays there until volatility
            closes below the re-entry level, and then the SMA decides again. It never buys on its own. Each
            index has its own window, exit and re-entry, calibrated jointly with its SMA band:
            {(["sp500", "nasdaq100"] as const).map((index) => (
              <span key={index} className="block">
                {index === "sp500" ? "SPX" : "NDX"}: {SMA_VOL_GATE[index].windowDays} days, exit above{" "}
                {pct(SMA_VOL_GATE[index].exitAbove)}, re-enter below {pct(SMA_VOL_GATE[index].reenterBelow)}.
              </span>
            ))}
            <span className="mt-2 block">
              The same switch adds an RSI crash brake for steady, grinding sell-offs whose daily moves are too
              even to lift volatility: when the index&apos;s Wilder RSI closes below the exit level the strategy
              also moves risk-off, and the brake releases once RSI closes above the re-entry level. It never buys
              on its own either. Both indices: {SMA_RSI_BRAKE_PARAMS_TEXT}.
            </span>
          </InfoPopoverButton>
        </span>
      </div>
      <label
        htmlFor={id}
        className="flex min-h-[34px] cursor-pointer items-center gap-1.5 rounded-lg border border-card-border bg-input-bg px-2.5 py-1 text-sm text-foreground @min-[13rem]:h-[34px] @min-[13rem]:gap-2 @min-[13rem]:px-3 @min-[13rem]:py-0"
      >
        <input
          id={id}
          type="checkbox"
          data-testid="sma-vol-gate"
          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="flex min-w-0 flex-1 flex-col @min-[13rem]:flex-row @min-[13rem]:items-center @min-[13rem]:justify-between @min-[13rem]:gap-2">
          {GATE_LINES.length === 1 ? (
            <span className="truncate">{SMA_VOL_GATE_PARAMS_TEXT}</span>
          ) : (
            // Per-index gates differ: one short line each fits the fixed-height box
            // on a phone, where the joined text would truncate away NDX entirely.
            <span className="flex min-w-0 flex-col text-[11px] leading-tight @min-[13rem]:text-xs">
              {GATE_LINES.map((line) => (
                <span key={line} className="truncate">{line}</span>
              ))}
            </span>
          )}
          <span
            data-testid="sma-rsi-brake-params"
            title={`RSI crash brake: ${SMA_RSI_BRAKE_PARAMS_TEXT}`}
            className="flex min-w-0 flex-col text-[11px] leading-tight @min-[13rem]:shrink-0 @min-[13rem]:text-right @min-[13rem]:text-xs"
          >
            <span className="truncate @min-[13rem]:hidden">{SMA_RSI_BRAKE_PARAMS_TEXT}</span>
            {BRAKE_LINES.map((line) => (
              <span key={line} className="hidden whitespace-nowrap @min-[13rem]:block">{line}</span>
            ))}
          </span>
        </span>
      </label>
    </div>
  );
}

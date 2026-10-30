"use client";

import { useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { SMA_VOL_GATE, SMA_VOL_GATE_PARAMS_TEXT } from "@/lib/simulation/vol-gate";

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function VolGateCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted font-medium flex items-center gap-1.5">
        <span>Volatility</span>
        <span className="ml-auto inline-flex items-center">
          <InfoPopoverButton label="Volatility">
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
          </InfoPopoverButton>
        </span>
      </div>
      <label
        htmlFor={id}
        className="flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border border-card-border bg-input-bg px-3 text-sm text-foreground"
      >
        <input
          id={id}
          type="checkbox"
          data-testid="sma-vol-gate"
          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="truncate">{SMA_VOL_GATE_PARAMS_TEXT}</span>
      </label>
    </div>
  );
}

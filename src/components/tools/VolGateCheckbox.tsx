"use client";

import { useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";
import { SMA_VOL_GATE, SMA_VOL_GATE_LABEL } from "@/lib/simulation/vol-gate";

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
          <InfoPopoverButton label={SMA_VOL_GATE_LABEL}>
            Adds a second risk-off rule on top of each SMA. At every close the index&apos;s
            {` ${SMA_VOL_GATE.windowDays}`}-day realized volatility is measured (standard deviation of the
            last {SMA_VOL_GATE.windowDays} daily log returns × √252). Above {pct(SMA_VOL_GATE.exitAbove)} the
            strategy moves to the risk-off asset even if the SMA says invested; it stays there until volatility
            closes below {pct(SMA_VOL_GATE.reenterBelow)}, and then the SMA decides again. It never buys on its
            own. Tested on NDX it fired about once every four years; on SPX the SMA has usually exited already.
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
        <span className="truncate">{SMA_VOL_GATE_LABEL}</span>
      </label>
    </div>
  );
}

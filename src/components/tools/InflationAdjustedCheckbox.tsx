"use client";

import { useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";

/** "SMA buffer inflation adjusted": run every SMA band on the CPI-deflated index. */
export function InflationAdjustedCheckbox({
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
        <span>SMA Buffer</span>
        <span className="ml-auto inline-flex items-center">
          <InfoPopoverButton label="SMA buffer inflation adjusted">
            Runs each SMA band on the index divided by CPI, so both the price and its moving average are in
            real dollars. A nominal rise that only keeps pace with inflation no longer holds the strategy in:
            with prices rising 10% a year, a 200-day SMA lags the price by about 4% more than it would in real
            terms, so the exit and re-entry levels move up by about that much. Each day uses the CPI that had
            been published by then (a month&apos;s CPI counts from the 15th of the next month). The vol gate and
            RSI brake still read the nominal index.
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
          data-testid="sma-inflation-adjusted"
          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="truncate text-xs">Inflation adjusted</span>
      </label>
    </div>
  );
}

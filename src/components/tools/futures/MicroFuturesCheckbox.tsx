"use client";

import { useId } from "react";
import { InfoPopoverButton } from "@/components/ui/InfoPopoverButton";

/** Futures-page switch for carrying each sleeve's remainder in MES/MNQ. */
export function MicroFuturesCheckbox({
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
        <span>Micro Futures</span>
        <span className="ml-auto inline-flex items-center">
          <InfoPopoverButton label="Micro futures">
            Sizes each sleeve in Micro E-minis (MES for SPX, MNQ for NDX), each a tenth of an ES/NQ, so leverage
            tracks within one micro of target instead of one full contract. Full contracts still carry every whole
            ten micros: micros cost about 2.7× the commission per dollar ($0.62 against $2.24–$2.45 a contract) and
            are rolled every quarter too. Buys take whole ES/NQ plus micros for the remainder; reductions sell the
            micros first; no trade ever swaps one size for the other, so the book can sit a few micros off target.
            Once one full contract is a smaller leverage step than the Leverage Tolerance band, no more micros are
            bought, and the ones held go with the next rebalance sell rather than on their own.
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
          data-testid="futures-micro"
          className="h-4 w-4 cursor-pointer accent-[var(--accent)]"
          checked={checked}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
        <span className="truncate text-xs">MES / MNQ remainder</span>
      </label>
    </div>
  );
}

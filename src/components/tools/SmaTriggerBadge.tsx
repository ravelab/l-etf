import type { SmaSignal } from "@/lib/simulation/types";
import { SMA_VOL_GATE } from "@/lib/simulation/vol-gate";

/** Names what moved a volatility-gated SMA position: the SMA band or the gate. */
export function SmaTriggerBadge({ trigger, vol }: { trigger: NonNullable<SmaSignal["trigger"]>; vol?: number | null }) {
  const isVol = trigger === "vol";
  const label = isVol
    ? vol != null && Number.isFinite(vol) ? `Vol ${Math.round(vol * 100)}%` : "Vol"
    : "SMA";
  return (
    <span
      data-testid="sma-trigger"
      data-trigger={trigger}
      title={isVol ? `Triggered by the volatility gate (${SMA_VOL_GATE.windowDays}-day realized volatility)` : "Triggered by the SMA band"}
      className={`ml-2 inline-block rounded border px-1.5 py-px text-[11px] font-medium leading-4 align-middle ${
        isVol ? "border-amber-400/50 text-amber-300" : "border-card-border text-muted"
      }`}
    >
      {label}
    </span>
  );
}

import type { SmaSignal } from "@/lib/simulation/types";

const finite = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

const TRIGGER_TITLE = {
  sma: "Triggered by the SMA band",
  vol: "Triggered by the volatility gate (realized volatility)",
  rsi: "Triggered by the RSI crash brake (Wilder RSI)",
  shock: "Triggered by the volatility-shock gate (short-window over baseline realized volatility)",
} as const;

/** Names what moved a gated SMA position: the SMA band, the vol gate, the RSI brake or the shock gate. */
export function SmaTriggerBadge({ trigger, vol, rsi, shock }: {
  trigger: NonNullable<SmaSignal["trigger"]>;
  vol?: number | null;
  rsi?: number | null;
  shock?: number | null;
}) {
  const isGate = trigger !== "sma";
  const label = trigger === "vol"
    ? finite(vol) ? `Vol ${Math.round(vol * 100)}%` : "Vol"
    : trigger === "rsi"
      ? finite(rsi) ? `RSI ${Math.round(rsi)}` : "RSI"
      : trigger === "shock"
        ? finite(shock) ? `Shock ${shock.toFixed(2)}x` : "Shock"
        : "SMA";
  return (
    <span
      data-testid="sma-trigger"
      data-trigger={trigger}
      title={TRIGGER_TITLE[trigger]}
      className={`ml-2 inline-block rounded border px-1.5 py-px text-[11px] font-medium leading-4 align-middle ${
        isGate ? "border-amber-400/50 text-amber-300" : "border-card-border text-muted"
      }`}
    >
      {label}
    </span>
  );
}

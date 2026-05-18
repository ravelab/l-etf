"use client";

interface RunSpinnerOverlayProps {
  active: boolean;
  label?: string;
  pct?: number;
}

export function RunSpinnerOverlay({ active, label, pct }: RunSpinnerOverlayProps) {
  if (!active) return null;
  const percent = typeof pct === "number" && Number.isFinite(pct)
    ? Math.round(Math.max(0, Math.min(100, pct)))
    : null;
  return (
    <div
      className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-full border border-card-border bg-card-bg/90 px-3 py-1.5 text-xs text-muted shadow-lg backdrop-blur pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent"
        aria-hidden="true"
      />
      {percent !== null && (
        <span className="tabular-nums font-medium text-accent">{percent}%</span>
      )}
      {label && <span className="text-foreground">{label}</span>}
    </div>
  );
}

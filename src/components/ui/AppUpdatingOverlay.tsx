"use client";

interface AppUpdatingOverlayProps {
  active: boolean;
  /** Headline shown next to the spinner. */
  title?: string;
  /** Secondary line explaining what is about to happen. */
  detail?: string;
}

/**
 * Blocking popup shown for the moment between detecting a new deployment and
 * reloading onto it, so the reload reads as an update rather than a page that
 * threw away what the user was doing.
 */
export function AppUpdatingOverlay({
  active,
  title = "Updating app",
  detail = "Reloading to load the latest version…",
}: AppUpdatingOverlayProps) {
  if (!active) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-xs items-center gap-3 rounded-xl border border-card-border bg-card-bg px-5 py-4 shadow-xl">
        <span
          className="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted">{detail}</p>
        </div>
      </div>
    </div>
  );
}

import { useCallback, useState } from "react";

type RunProgress = { pct: number; label: string };

function clampProgress(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export function useMonotonicRunProgress() {
  const [runProgress, setRunProgressState] = useState<RunProgress | null>(null);

  const setRunProgress = useCallback((next: RunProgress | null) => {
    setRunProgressState((current) => {
      if (next === null) return null;

      const nextPct = clampProgress(next.pct);
      if (!current) return { ...next, pct: nextPct };
      if (nextPct >= 100) return { ...next, pct: 100 };

      const monotonicPct =
        nextPct > current.pct
          ? nextPct
          : Math.min(99, current.pct + 0.2);

      return {
        pct: monotonicPct,
        label: next.label || current.label,
      };
    });
  }, []);

  return [runProgress, setRunProgress] as const;
}

"use client";

import { useCallback, useMemo, useState } from "react";
import { resolvePresetContext } from "@/lib/simulation/presets";
import type { RunSummary } from "@/lib/run-summary";

/** Storage-level key is `runSummaryInputs` (kept for backwards cache compat); hook-level field is `runSummary`. */
type SnapshotFragment = {
  runSummaryInputs?: unknown;
};

/**
 * Validate a persisted snapshot. Old caches may be missing fields introduced later;
 * any missing required field drops the snapshot back to null so display blocks won't render.
 */
export function toValidRunSummary(value: unknown): RunSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  
  // Required core fields for any summary
  if (
    typeof v.startDate !== "string" ||
    typeof v.endDate !== "string"
  ) {
    return null;
  }

  return {
    letf: typeof v.letf === "string" ? v.letf : (typeof v.preset === "string" ? v.preset : "UPRO"),
    startDate: v.startDate,
    endDate: v.endDate,
    windowLength: typeof v.windowLength === "number" ? v.windowLength : 10,
    smaSpPeriod: typeof v.smaSpPeriod === "number" ? v.smaSpPeriod : (typeof v.smaPsp === "number" ? v.smaPsp : 175),
    smaSpBuffer: typeof v.smaSpBuffer === "number" ? v.smaSpBuffer : (typeof v.smatsp === "number" ? v.smatsp : 3.5),
    smaNqPeriod: typeof v.smaNqPeriod === "number" ? v.smaNqPeriod : (typeof v.smaPnq === "number" ? v.smaPnq : 150),
    smaNqBuffer: typeof v.smaNqBuffer === "number" ? v.smaNqBuffer : (typeof v.smatnq === "number" ? v.smatnq : 12),
    riskOffAsset: typeof v.riskOffAsset === "string" ? v.riskOffAsset : (typeof v.ro === "string" ? v.ro : "SGOV"),
    tradeAfterHours: typeof v.tradeAfterHours === "boolean" ? v.tradeAfterHours : false,
    amount: typeof v.amount === "number" && Number.isFinite(v.amount) ? v.amount : undefined,
    leverageTolerance: typeof v.leverageTolerance === "string" ? v.leverageTolerance : undefined,
  } as RunSummary;
}

export function useRunSummary(initialFromCache: unknown) {
  const [runSummary, setRunSummary] = useState<RunSummary | null>(() =>
    toValidRunSummary(initialFromCache)
  );

  const applyRunSummaryFromSnapshot = useCallback((snapshot: SnapshotFragment) => {
    if (snapshot.runSummaryInputs !== undefined) {
      setRunSummary(toValidRunSummary(snapshot.runSummaryInputs));
    }
  }, []);

  const clearRunSummary = useCallback(() => setRunSummary(null), []);

  return {
    runSummary,
    setRunSummary,
    applyRunSummaryFromSnapshot,
    clearRunSummary,
  };
}

/** Derives preset context from a snapshot. Null pre-first-run so callers gate render. */
export function useRunDisplay(runSummary: RunSummary | null) {
  return useMemo(() => {
    if (!runSummary) return null;
    const preset = resolvePresetContext(runSummary.letf);
    return {
      summary: runSummary,
      isCombo: preset.isCombo,
      selectedPreset: preset.selectedPreset,
      comboSubs: preset.comboSubs,
      comboLabels: preset.comboLabels,
      leverage: preset.selectedPreset.leverage,
      expenseRatio: preset.selectedPreset.expenseRatio,
    };
  }, [runSummary]);
}

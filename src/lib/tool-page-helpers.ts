import type { SharedFieldValues } from "@/components/tools/SharedToolInputs";
import type { SmaComparisonRow } from "@/lib/simulation/types";

type SetterMap = Partial<{
  [K in keyof SharedFieldValues]: (value: NonNullable<SharedFieldValues[K]>) => void;
}>;

export function applySharedFieldChange<K extends keyof SharedFieldValues>(
  field: K,
  value: NonNullable<SharedFieldValues[K]>,
  options: {
    setters?: SetterMap;
    onLetf?: (value: NonNullable<SharedFieldValues[K]>) => void;
  }
): void {
  if (field === "letf" && options.onLetf) {
    options.onLetf(value);
    return;
  }

  const setter = options.setters?.[field] as ((value: NonNullable<SharedFieldValues[K]>) => void) | undefined;
  setter?.(value);
}

export function getSweepDisplayStartDate(
  rows?: SmaComparisonRow[],
  baseline?: SmaComparisonRow | null,
): string | undefined {
  return rows?.find((row) => Boolean(row.earliestStartDate))?.earliestStartDate ?? baseline?.earliestStartDate;
}

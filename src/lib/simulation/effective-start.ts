import type { EtfConfig } from "@/lib/simulation/types";

/**
 * Compute an "effective start date" for a simulation window given aligned
 * risk-off price series.
 *
 * We start only once every risk-off component has a finite, positive price.
 * This matches the intent of "can't trade what doesn't exist yet" and keeps
 * results consistent across pages that reuse the same risk-off basket.
 */
export function effectiveStartDateFromAlignedSeries(params: {
  requestedStartDate: string;
  dates: string[];
  closeByTicker: Partial<Record<EtfConfig["riskOffAsset"], number[]>> | Record<string, number[]>;
}): string {
  let effective = params.requestedStartDate;
  const seriesList = Object.values(params.closeByTicker);
  for (const values of seriesList) {
    if (!values || values.length === 0) continue;
    const idx = values.findIndex((v) => Number.isFinite(v) && v > 0);
    if (idx < 0) continue;
    const d = params.dates[idx];
    if (d && d > effective) effective = d;
  }
  return effective;
}

export function maxIsoDate(a: string, b: string): string {
  return a > b ? a : b;
}


// What `runParallelSimulations` returns, and the one function that shapes
// per-config window buckets into it. Worker-safe: the main thread and the Web
// Worker (`worker.ts`) both shape through `shapeBucketResults`, so the two
// execution paths cannot disagree on filtering, labels or parameter values.

import type { EtfConfig, SmaComparisonRow } from "./types";
import { summarizeSmaRow, type RollingSimulationPoint, type RollingWindow } from "./rolling";
import type { WindowSource } from "./window-extraction";
import type { FuturesTaxRates } from "./futures-tax";

export type ParallelMode = "sweep" | "variants" | "variant-summaries";

export interface ConfigSimulationBucket {
  configId: string;
  simulations: RollingSimulationPoint[];
}

export interface VariantSimulations {
  label: string;
  simulations: RollingSimulationPoint[];
}

export interface VariantSummaryResult {
  label: string;
  summary: SmaComparisonRow;
}

export type ParallelResult = SmaComparisonRow[] | VariantSimulations[] | VariantSummaryResult[];

export type MonthlyCpi = Array<{ date: string; value: number }>;

export interface ShapeContext {
  configs: EtfConfig[];
  /** Display label per config, by position in `configs`; defaults to the config id. */
  labels?: string[];
  /** Sweep parameter value keyed by config.id. */
  paramValues?: Record<string, number>;
  monthlyCpi?: MonthlyCpi;
}

/**
 * - `sweep`: one summary row per config that produced any window, stamped with
 *   its parameter value. Rows are NOT 1:1 with configs; join on
 *   `row.parameterValue`, never by index.
 * - `variant-summaries` / `variants`: one entry per config, in config order,
 *   labelled; a config with no windows gets an empty summary / list.
 */
export function shapeBucketResults(
  mode: ParallelMode,
  buckets: ConfigSimulationBucket[],
  { configs, labels, paramValues, monthlyCpi }: ShapeContext
): ParallelResult {
  if (mode === "sweep") {
    return buckets
      .filter((bucket) => bucket.simulations.length > 0)
      .map((bucket) => summarizeSmaRow(paramValues?.[bucket.configId] ?? 0, bucket.simulations, monthlyCpi));
  }

  const simulationsById = new Map(buckets.map((bucket) => [bucket.configId, bucket.simulations]));
  const labelled = configs.map((config, index) => ({
    label: labels?.[index] ?? config.id,
    simulations: simulationsById.get(config.id) ?? [],
  }));
  if (mode === "variants") return labelled;
  return labelled.map(({ label, simulations }) => ({
    label,
    summary: summarizeSmaRow(0, simulations, monthlyCpi),
  }));
}

/** Message the main thread posts to `worker.ts`. */
export interface RegularWorkerRequest extends ShapeContext {
  precomputedDailyValues: Array<WindowSource & { configId: string }>;
  windows: RollingWindow[];
  /** `simulation-buckets` returns raw buckets for the caller to merge with wrapped windows. */
  mode: ParallelMode | "simulation-buckets";
  taxRates?: FuturesTaxRates;
}

export type WorkerResponse<T> =
  | { type: "result"; result: T }
  | { type: "error"; message: string };

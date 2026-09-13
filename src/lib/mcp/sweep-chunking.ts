// Splitting a rolling-window sweep into chunks the engine can run one at a time.
//
// `runParallelSimulations` precomputes a full daily-value series per config and
// holds every one of them for the life of the call. That is ~2.8 MB per config
// over full history, so a 400-config sweep measured 1.1 GB of retained heap —
// memory, not CPU, is what actually bounded sweep breadth (24 configs runs in
// ~0.7 s against a 300 s function budget). Chunking the config list keeps peak
// heap flat at roughly `SWEEP_CHUNK_SIZE x 2.8 MB` and leaves the time budget
// in `compute-budget.ts` as the only real ceiling.

import type { EtfConfig } from "@/lib/simulation/types";

/**
 * Configs per engine call. Each chunk pays a fixed setup cost (index context +
 * rolling-window rebuild, ~50 ms locally), so small chunks waste time while
 * large ones reintroduce the memory ceiling this exists to remove.
 */
export const SWEEP_CHUNK_SIZE = 48;

/**
 * Split configs into consecutive chunks of at most `size`. Returns fresh
 * arrays, so a caller mutating a chunk cannot reach back into the source list.
 */
export function chunkConfigs<T>(configs: readonly T[], size: number): T[][] {
  if (!Number.isFinite(size) || size < 1) {
    throw new RangeError(`Chunk size must be a positive number, received ${size}.`);
  }
  const chunks: T[][] = [];
  for (let start = 0; start < configs.length; start += size) {
    chunks.push(configs.slice(start, start + size));
  }
  return chunks;
}

/**
 * Stamp every config with its index in the **whole** list, keyed by config id.
 *
 * The engine drops any config whose bucket came back empty, so sweep rows are
 * "requested order minus the drops" and are joined on `row.parameterValue`
 * rather than array position (see `joinSweepRowsToConfigs`). Build this once
 * over the full list and hand the same map to every chunk: restamping per chunk
 * would restart the indices at 0 and make later chunks' rows overwrite earlier
 * ones during the join.
 */
export function buildGlobalParamValues(configs: readonly EtfConfig[]): Record<string, number> {
  return Object.fromEntries(configs.map((config, index) => [config.id, index]));
}

/**
 * Map a chunk-local engine fraction onto the whole sweep's 0..1 progress, so
 * progress notifications advance smoothly instead of resetting per chunk.
 */
export function chunkProgressFraction(
  completedChunks: number,
  totalChunks: number,
  withinChunk: number,
): number {
  if (totalChunks <= 0) return 1;
  if (completedChunks >= totalChunks) return 1;
  const done = Math.max(0, completedChunks);
  const within = Math.max(0, Math.min(1, withinChunk));
  return Math.min(1, (done + within) / totalChunks);
}

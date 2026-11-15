// Web Worker pooling for rolling-window extraction. Browser only: callers
// check `typeof Worker` before reaching here.

import type { EtfConfig } from "./types";
import type { PrecomputedConfigDailyValues } from "./precompute";
import type { WorkerResponse } from "./parallel-results";

type WorkerKind = "regular" | "wrapped";

// Dev rebuilds the worker bundle on every edit; a pooled worker would keep
// running the stale code, so only production reuses them.
const SHOULD_REUSE_WORKERS = process.env.NODE_ENV === "production";
const FALLBACK_HARDWARE_CONCURRENCY = 4;

interface PooledWorkerEntry {
  worker: Worker;
  busy: boolean;
}

const workerPools: Record<WorkerKind, PooledWorkerEntry[]> = {
  regular: [],
  wrapped: [],
};

function createWorker(kind: WorkerKind): Worker {
  return kind === "wrapped"
    ? new Worker(new URL("./wrapped-worker.ts", import.meta.url))
    : new Worker(new URL("./worker.ts", import.meta.url));
}

function acquireWorker(kind: WorkerKind): PooledWorkerEntry {
  if (!SHOULD_REUSE_WORKERS) {
    return { worker: createWorker(kind), busy: true };
  }
  const idle = workerPools[kind].find((entry) => !entry.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  const entry: PooledWorkerEntry = { worker: createWorker(kind), busy: true };
  workerPools[kind].push(entry);
  return entry;
}

function releaseWorker(kind: WorkerKind, entry: PooledWorkerEntry, discard = false): void {
  if (!SHOULD_REUSE_WORKERS) {
    entry.worker.terminate();
    return;
  }
  entry.busy = false;
  entry.worker.onmessage = null;
  entry.worker.onerror = null;
  if (!discard) return;

  entry.worker.terminate();
  const pool = workerPools[kind];
  const idx = pool.indexOf(entry);
  if (idx >= 0) pool.splice(idx, 1);
}

/** Post one request to a pooled worker and resolve with its result. A failed worker is discarded. */
export function runInWorker<T>(kind: WorkerKind, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const entry = acquireWorker(kind);
    entry.worker.onmessage = (event: MessageEvent<WorkerResponse<T>>) => {
      if (event.data.type === "result") {
        resolve(event.data.result);
        releaseWorker(kind, entry);
      } else {
        reject(new Error(event.data.message));
        releaseWorker(kind, entry, true);
      }
    };
    entry.worker.onerror = (event) => {
      reject(event);
      releaseWorker(kind, entry, true);
    };
    entry.worker.postMessage(request);
  });
}

/** Workers to spread `configCount` configs over: one per core, never more than configs. */
export function workerCountFor(configCount: number): number {
  const hwConcurrency = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : FALLBACK_HARDWARE_CONCURRENCY;
  return Math.min(hwConcurrency || FALLBACK_HARDWARE_CONCURRENCY, configCount);
}

/** Precomputed series without the `Set`, which structured clone would copy for nothing. */
type CloneablePrecomputed = Omit<PrecomputedConfigDailyValues, "tradeDayIndexSet">;

function withoutTradeDayIndexSet(precomputed: PrecomputedConfigDailyValues): CloneablePrecomputed {
  const { tradeDayIndexSet, ...rest } = precomputed;
  void tradeDayIndexSet;
  return rest;
}

export interface WorkerShare {
  configs: EtfConfig[];
  /** Labels for `configs`, sliced from the caller's labels when given. */
  labels?: string[];
  precomputedDailyValues: CloneablePrecomputed[];
}

/**
 * Split configs into contiguous runs, one per worker, each with its own
 * precomputed series. Contiguous runs keep the concatenated worker results in
 * config order.
 */
export function partitionForWorkers(
  configs: EtfConfig[],
  precomputedDailyValues: PrecomputedConfigDailyValues[],
  labels?: string[]
): WorkerShare[] {
  const numWorkers = workerCountFor(configs.length);
  const configsPerWorker = Math.ceil(configs.length / numWorkers);
  const precomputedById = new Map(precomputedDailyValues.map((precomputed) => [precomputed.configId, precomputed]));
  const shares: WorkerShare[] = [];

  for (let start = 0; start < configs.length; start += configsPerWorker) {
    const end = Math.min(start + configsPerWorker, configs.length);
    const shareConfigs = configs.slice(start, end);
    shares.push({
      configs: shareConfigs,
      labels: labels?.slice(start, end),
      precomputedDailyValues: shareConfigs
        .map((config) => precomputedById.get(config.id))
        .filter((precomputed): precomputed is PrecomputedConfigDailyValues => precomputed !== undefined)
        .map(withoutTradeDayIndexSet),
    });
  }
  return shares;
}

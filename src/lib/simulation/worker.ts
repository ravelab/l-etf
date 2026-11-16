// Web Worker for rolling-window extraction over precomputed daily values.
// It holds no logic of its own: windows go through `window-extraction.ts` and
// results through `parallel-results.ts`, the same code the main thread runs.

import {
  shapeBucketResults,
  type ConfigSimulationBucket,
  type ParallelResult,
  type RegularWorkerRequest,
  type WorkerResponse,
} from "./parallel-results";
import { extractRegularWindowSimulations } from "./window-extraction";

function handleRequest(request: RegularWorkerRequest): ConfigSimulationBucket[] | ParallelResult {
  const buckets = request.precomputedDailyValues.map((precomputed) => ({
    configId: precomputed.configId,
    simulations: extractRegularWindowSimulations(precomputed, request.windows, request.taxRates),
  }));
  return request.mode === "simulation-buckets"
    ? buckets
    : shapeBucketResults(request.mode, buckets, request);
}

self.onmessage = (event: MessageEvent<RegularWorkerRequest>) => {
  let response: WorkerResponse<ConfigSimulationBucket[] | ParallelResult>;
  try {
    response = { type: "result", result: handleRequest(event.data) };
  } catch (err) {
    console.error("[worker] ERROR:", err);
    response = { type: "error", message: err instanceof Error ? err.message : "Worker error" };
  }
  self.postMessage(response);
};

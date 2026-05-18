import {
  simulateFuturesSmaStrategy,
  type FuturesStrategyParams,
  type FuturesStrategyResult,
} from "./futures";

type ProgressHandler = (completed: number, total: number) => void;

type WorkerMessage =
  | { id: number; type: "result"; result: FuturesStrategyResult }
  | { id: number; type: "error"; message: string };

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Aborted", "AbortError");
}

function createFuturesWorker(): Worker {
  return new Worker(new URL("./futures-worker.ts", import.meta.url));
}

function runFuturesWorkerTask(
  id: number,
  params: FuturesStrategyParams,
  signal?: AbortSignal
): Promise<FuturesStrategyResult> {
  return new Promise((resolve, reject) => {
    assertNotAborted(signal);
    const worker = createFuturesWorker();
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.type === "result") {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.message));
      }
    };
    worker.onerror = (event) => {
      cleanup();
      reject(event);
    };
    worker.postMessage({ id, params });
  });
}

export async function runParallelFuturesStrategies({
  plans,
  onProgress,
  signal,
}: {
  plans: FuturesStrategyParams[];
  onProgress?: ProgressHandler;
  signal?: AbortSignal;
}): Promise<FuturesStrategyResult[]> {
  assertNotAborted(signal);
  if (plans.length === 0) return [];

  if (typeof Worker === "undefined") {
    const results: FuturesStrategyResult[] = [];
    for (let i = 0; i < plans.length; i++) {
      assertNotAborted(signal);
      results.push(simulateFuturesSmaStrategy(plans[i]!));
      onProgress?.(i + 1, plans.length);
    }
    return results;
  }

  const maxWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, plans.length));
  const results = new Array<FuturesStrategyResult>(plans.length);
  let nextIndex = 0;
  let completed = 0;

  const runLane = async () => {
    while (nextIndex < plans.length) {
      assertNotAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runFuturesWorkerTask(index, plans[index]!, signal);
      completed += 1;
      onProgress?.(completed, plans.length);
    }
  };

  await Promise.all(Array.from({ length: maxWorkers }, () => runLane()));
  return results;
}

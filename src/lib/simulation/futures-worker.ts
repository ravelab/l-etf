import { runFuturesPlan, type FuturesRunPlan } from "./futures-run-plan";

type FuturesWorkerRequest = {
  id: number;
  plan: FuturesRunPlan;
};

self.onmessage = (event: MessageEvent<FuturesWorkerRequest>) => {
  try {
    const result = runFuturesPlan(event.data.plan);
    self.postMessage({ id: event.data.id, type: "result", result });
  } catch (error) {
    self.postMessage({
      id: event.data.id,
      type: "error",
      message: error instanceof Error ? error.message : "Futures worker failed",
    });
  }
};
